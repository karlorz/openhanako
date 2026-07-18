# Release Digest Generation

The release-digest generator supports provider-neutral BYOK configuration for
OpenAI-compatible Responses and Chat Completions APIs. This configuration is
used only to generate `release-digest.v1.json`; it does not configure HanaAgent
runtime chat or the remote server.

## Local configuration

Install direnv and enable its shell hook, then create an ignored project `.env`
from `.env.example`:

```text
base_url=https://api.x.ai/v1
model=grok-4
api_backend=chat-completions
OPENHANAKO_RELEASE_DIGEST_SECRET_FILE=$HOME/.secrets/openhanako-release-digest
```

The accepted `api_backend` values are `responses` and `chat-completions`.
Create the configured secret file with dotenv syntax:

```text
api_key=[REDACTED:api-key]
```

Restrict the file before allowing direnv to load it:

```bash
chmod 600 "$HOME/.secrets/openhanako-release-digest"
direnv allow
```

`.envrc` parses both files as dotenv data when the secret file exists. It does
not shell-source them, scan the secrets directory, print the key, or change
file permissions. The secret file is optional for normal development and is
required only when the generator makes a provider request; without it, the
generator fails closed with an `API_KEY` error.

## Generate a digest

Run the generator through direnv so the project and secret settings are loaded:

```bash
direnv exec . node scripts/generate-release-digest.mjs \
  --tag v0.407.15-karlorz.1 \
  --source-out /tmp/openhanako-release-digest-source.json \
  --out release-digest.v1.json
```

CLI flags override dotenv values:

```bash
direnv exec . node scripts/generate-release-digest.mjs \
  --tag v0.407.15-karlorz.1 \
  --base-url https://api.x.ai/v1 \
  --model grok-4 \
  --backend chat-completions
```

Uppercase `BASE_URL`, `MODEL`, `API_KEY`, and `API_BACKEND` are accepted for
CI environments. Existing `OPENAI_API_BASE_URL`, `OPENAI_MODEL`,
`OPENAI_API_KEY`, and `OPENAI_BACKEND` remain compatibility aliases. Explicit
CLI values have highest precedence, followed by generic environment values,
OpenAI compatibility aliases, and defaults.

`--no-llm` only writes or prints the deterministic source packet and does not
require an API key. Generating a fork digest does not itself authorize changing
the committed digest, publishing a tag or release, pushing, or deploying a
server; those actions remain separately attended release gates.
