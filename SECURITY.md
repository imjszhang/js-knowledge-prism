# Security Policy

## Overview

JS Knowledge Prism is a local knowledge management tool. It processes files on disk and communicates with a **user-configured** LLM API endpoint.

## What this tool does

- Reads journal markdown files from the local filesystem
- Sends content to an OpenAI-compatible API endpoint for processing
- Writes generated output back to local files
- Registers HTTP routes on the OpenClaw gateway to serve a knowledge graph hub page and pre-generated graph HTML files

## What this tool does NOT do

- **No telemetry**: We do not collect, transmit, or store any usage data
- **No external API calls**: The only network communication is to the API endpoint you configure
- **No authentication bypass**: API keys are stored locally in `.env` files or OpenClaw config
- **No arbitrary code execution**: The tool processes markdown text only
- **No arbitrary file serving**: HTTP routes only serve pre-generated `graph.html` files from registered knowledge base directories listed in the registry

## Configuration security

- API keys should be stored in `.env` files (included in `.gitignore`)
- Never commit `.env` files to version control
- When using OpenClaw, API keys can be stored in `~/.openclaw/openclaw.json` with `${ENV_VAR}` references

## HTTP route security

The plugin registers HTTP routes on the OpenClaw gateway under `/plugins/js-knowledge/prism/`:

- All routes use `auth: "plugin"`, meaning OpenClaw handles authentication before requests reach the handler
- The graph file route only serves `graph.html` from directories explicitly listed in the registry (`registry.json`); it does not accept arbitrary file paths
- The registry is a local JSON file managed by the user via CLI or AI tools — no external input can modify it
- No user-uploaded content is served; graph HTML is generated locally by the tool itself

## Static analysis notes

Security scanners (e.g., VirusTotal) may flag this tool because it:
- Uses `fetch` / `http` / `https` for API calls
- Constructs dynamic URLs from configuration
- Reads and writes files based on user input paths
- Registers HTTP routes that serve local HTML files

These are standard patterns for a local CLI tool that communicates with configurable API endpoints and provides a web UI through the OpenClaw gateway.

## Reporting vulnerabilities

If you discover a security issue, please open a GitHub issue or contact the maintainer directly.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
