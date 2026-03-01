# Security Policy

## Overview

JS Knowledge Prism is a local knowledge management tool. It processes files on disk and communicates with a **user-configured** LLM API endpoint.

## What this tool does

- Reads journal markdown files from the local filesystem
- Sends content to an OpenAI-compatible API endpoint for processing
- Writes generated output back to local files

## What this tool does NOT do

- **No telemetry**: We do not collect, transmit, or store any usage data
- **No external API calls**: The only network communication is to the API endpoint you configure
- **No authentication bypass**: API keys are stored locally in `.env` files or OpenClaw config
- **No arbitrary code execution**: The tool processes markdown text only

## Configuration security

- API keys should be stored in `.env` files (included in `.gitignore`)
- Never commit `.env` files to version control
- When using OpenClaw, API keys can be stored in `~/.openclaw/openclaw.json` with `${ENV_VAR}` references

## Static analysis notes

Security scanners (e.g., VirusTotal) may flag this tool because it:
- Uses `fetch` / `http` / `https` for API calls
- Constructs dynamic URLs from configuration
- Reads and writes files based on user input paths

These are standard patterns for a local CLI tool that communicates with configurable API endpoints.

## Reporting vulnerabilities

If you discover a security issue, please open a GitHub issue or contact the maintainer directly.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
