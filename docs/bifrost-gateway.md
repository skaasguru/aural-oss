# Claude and AssemblyAI through Bifrost

Aural can route text generation, transcription, and speech synthesis through a Bifrost
instance you operate. The [example environment](examples/speech-bifrost-assemblyai.env)
shows separate model settings for interactive replies and reports.

## Gateway setup

1. Configure an Anthropic provider for text generation and select models available to your account.
2. Add an OpenAI-compatible provider for AssemblyAI speech synthesis. Use the provider settings
   in the example environment and choose an available speech model and voice.
3. Configure an HTTP relay named `assemblyai-stt` for AssemblyAI's Sync API. Forward
   `POST /v1/transcribe` using the provider credential stored in the gateway.
4. Issue an application virtual key with access to both providers and the transcription relay.
   Set it in Aural's server-side environment. Do not put provider credentials or virtual keys
   in source control.

Set the text and synthesis base URLs to your gateway's OpenAI-compatible `/v1` endpoint. Set the
transcription base URL to your gateway's `/relay/assemblyai-stt` endpoint; the adapter appends
`/v1/transcribe`. Restart the web server and voice relay, then verify text generation, synthesis,
and transcription independently before switching traffic.

AssemblyAI Sync transcription uploads a finished utterance at a time. It does not emit live
partial transcripts, and interruption detection is delayed until the utterance is transcribed.
See [Speech Providers](speech-providers.md) for adapter behavior and troubleshooting.
