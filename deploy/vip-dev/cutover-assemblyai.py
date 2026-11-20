#!/usr/bin/env python3
"""Switch Aural dev to Claude + AssemblyAI through Bifrost, only after a real round trip passes.

Run ON the VM from /srv/dev/apps/aural once the Anthropic and AssemblyAI keys exist in Bifrost
(either as ANTHROPIC_API_KEY / ASSEMBLYAI_API_KEY in /srv/dev/apps/vip/.env, or entered in the
Bifrost dashboard). Nothing is changed unless every probe succeeds:

  1. Claude chat for the interactive and the report model,
  2. AssemblyAI text-to-speech through the `assemblyai` provider (raw 24 kHz PCM),
  3. AssemblyAI Sync speech-to-text through the `assemblyai-stt` relay, transcribing (2).

Then the transitional Groq/Kokoro overrides are removed from .env, web and relay are recreated on
the compose defaults, and the Kokoro container is stopped. Prints statuses, never secret values.
"""
import json, os, re, struct, subprocess, sys, time, urllib.error, urllib.request

VIP = "/srv/dev/apps/vip"
AURAL = "/srv/dev/apps/aural"
COMPOSE = ["docker", "compose", "-f", "compose.supabase.yaml", "-f", "compose.app.yaml"]
TRANSITIONAL = ["AURAL_STT_PROVIDER", "AURAL_STT_BASE_URL", "AURAL_STT_MODEL", "AURAL_LLM_FAST_MODEL", "AURAL_LLM_REPORT_MODEL",
                "AURAL_TTS_BASE_URL", "AURAL_TTS_API_KEY", "AURAL_TTS_MODEL", "AURAL_TTS_VOICE", "AURAL_TTS_FORMAT",
                "AURAL_TTS_MAX_INPUT_CHARS", "AURAL_TTS_TIMEOUT_MS", "COMPOSE_PROFILES"]
SENTENCE = "Please describe a project where you improved the reliability of a production system."


def sh(*args, cwd=None, check=True):
    r = subprocess.run(args, cwd=cwd, text=True, capture_output=True)
    if check and r.returncode:
        raise SystemExit(f"FAILED {' '.join(args[:5])}: {r.stderr.strip()[-300:]}")
    return r


def read_env(path):
    return dict(l.rstrip("\n").split("=", 1) for l in open(path) if "=" in l and not l.lstrip().startswith("#"))


def bifrost():
    c = json.loads(sh("docker", "inspect", "vip-bifrost-1").stdout)[0]
    return c["NetworkSettings"]["Networks"]["dev-ingress"]["IPAddress"], dict(e.split("=", 1) for e in c["Config"]["Env"])


def post(ip, path, key, data, headers, timeout=60):
    req = urllib.request.Request(f"http://{ip}:8080{path}", data=data, headers={"Authorization": "Bearer " + key, **headers})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), round((time.monotonic() - started) * 1000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), round((time.monotonic() - started) * 1000)


def fail(step, status, body):
    text = body[:300].decode("utf8", "replace") if isinstance(body, bytes) else str(body)
    raise SystemExit(f"NOT SWITCHED: {step} failed (HTTP {status}): {text}")


def main():
    vip_env = read_env(f"{VIP}/.env")
    ip, live = bifrost()
    if any(vip_env.get(k, "") != live.get(k, "") for k in ("ANTHROPIC_API_KEY", "ASSEMBLYAI_API_KEY")):
        sh("docker", "compose", "up", "-d", "--wait", "bifrost", cwd=VIP)
        time.sleep(3)
        ip, live = bifrost()
        print("bifrost recreated with updated provider keys")
    key = live["AURAL_BIFROST_VK"]
    if "--without-probes" in sys.argv:
        print("WARNING: switching without verifying the providers (--without-probes)")
        return switch(*[compose_default(n) for n in ("AURAL_LLM_FAST_MODEL", "AURAL_LLM_REPORT_MODEL", "AURAL_TTS_MODEL", "AURAL_TTS_VOICE", "AURAL_STT_MODEL")])
    default = compose_default
    fast, report = default("AURAL_LLM_FAST_MODEL"), default("AURAL_LLM_REPORT_MODEL")
    tts_model, voice, stt_model = default("AURAL_TTS_MODEL"), default("AURAL_TTS_VOICE"), default("AURAL_STT_MODEL")

    for model in dict.fromkeys((fast, report)):
        body = {"model": model, "temperature": 0, "max_tokens": 64, "messages": [{"role": "user", "content": "Reply with exactly: ready"}]}
        status, raw, ms = post(ip, "/v1/chat/completions", key, json.dumps(body).encode(), {"Content-Type": "application/json"})
        if status != 200: fail(f"Claude chat ({model})", status, raw)
        print(f"PASS chat {model}: {json.loads(raw)['choices'][0]['message']['content'].strip()[:40]!r} in {ms} ms")

    body = {"model": tts_model, "voice": voice, "input": SENTENCE, "response_format": "pcm"}
    status, pcm, ms = post(ip, "/v1/audio/speech", key, json.dumps(body).encode(), {"Content-Type": "application/json"})
    if status != 200 or len(pcm) < 24_000: fail("AssemblyAI TTS", status, pcm if status != 200 else f"only {len(pcm)} bytes of audio")
    print(f"PASS tts {tts_model}/{voice}: {len(pcm)} bytes = {len(pcm) / 48000:.2f} s of 24 kHz PCM in {ms} ms")

    wav = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 24000, 48000, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm
    b = "----aural-cutover"
    form = (f'--{b}\r\nContent-Disposition: form-data; name="audio"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + wav + (
        f'\r\n--{b}\r\nContent-Disposition: form-data; name="config"; filename="blob"\r\nContent-Type: application/json\r\n\r\n' + json.dumps({"language_codes": "en"}) + f"\r\n--{b}--\r\n").encode()
    status, raw, ms = post(ip, "/relay/assemblyai-stt/v1/transcribe", key, form, {"Content-Type": f"multipart/form-data; boundary={b}", "X-AAI-Model": stt_model})
    if status != 200: fail("AssemblyAI STT relay", status, raw)
    heard = json.loads(raw).get("text", "")
    words = lambda s: set(re.findall(r"[a-z]+", s.lower()))
    overlap = len(words(heard) & words(SENTENCE)) / len(words(SENTENCE))
    print(f"PASS stt {stt_model}: heard {heard!r} ({overlap:.0%} of the spoken words) in {ms} ms")
    if overlap < 0.8: fail("speech round trip", 200, f"transcript does not match the synthesized sentence: {heard!r}")
    if "--probe-only" in sys.argv:
        print("probe only: nothing changed"); return
    switch(fast, report, tts_model, voice, stt_model)


def compose_default(name):
    match = re.search(r"\$\{" + name + r":-([^}]+)\}", open(f"{AURAL}/compose.app.yaml").read())
    if not match: raise SystemExit(f"compose.app.yaml has no default for {name}")
    return match.group(1)


def switch(fast, report, tts_model, voice, stt_model):
    env_path = f"{AURAL}/.env"
    lines = [l for l in open(env_path).read().splitlines() if l.split("=", 1)[0] not in TRANSITIONAL]
    backup = f"{AURAL}/backups/cutover-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.env"
    os.makedirs(os.path.dirname(backup), mode=0o700, exist_ok=True)
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, "w") as f: f.write(open(env_path).read())
    fd = os.open(env_path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: f.write("\n".join(lines) + "\n")
    os.replace(env_path + ".tmp", env_path)
    r = sh(*COMPOSE, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "web", "relay", cwd=AURAL, check=False)
    if r.returncode:
        os.replace(backup, env_path)
        sh(*COMPOSE, "up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", "web", "relay", cwd=AURAL, check=False)
        raise SystemExit("NOT SWITCHED: web/relay did not become healthy; previous configuration restored")
    sh("docker", "rm", "-f", "aural-kokoro-1", check=False)
    state_path = f"{AURAL}/deployment.json"
    state = json.load(open(state_path))
    state["llm"] = {"gateway": "bifrost", "interactive": fast, "report": report}
    state["stt"] = {"gateway": "bifrost relay assemblyai-stt", "model": stt_model}
    state["tts"] = {"gateway": "bifrost provider assemblyai", "model": tts_model, "voice": voice}
    json.dump(state, open(state_path, "w"), indent=2)
    print("SWITCHED: Aural web+relay now use Claude + AssemblyAI through Bifrost; Kokoro container removed")
    print("previous .env:", backup)


if __name__ == "__main__":
    main()
