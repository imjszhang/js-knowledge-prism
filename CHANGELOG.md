# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-03-01

### Added

- Core pipeline: journal → atoms → groups → synthesis
- Five AI tools for OpenClaw integration:
  - `knowledge_prism_process` — incremental pipeline execution
  - `knowledge_prism_status` — knowledge base status query
  - `knowledge_prism_new_perspective` — create perspective skeleton
  - `knowledge_prism_fill_perspective` — generate SCQA / Key Line content
  - `knowledge_prism_expand_kl` — expand Key Line into full document
- CLI commands: `init`, `process`, `status`, `new-perspective`
- OpenClaw plugin with CLI sub-commands (`openclaw prism ...`)
- Dev toolchain: `build`, `bump`, `commit`, `sync`, `release`
- Test suite using `node:test` (24 tests)
- SKILL.md for ClawHub/OpenClaw distribution
- Cross-platform install scripts (`install.sh`, `install.ps1`)
- Extension skills system with registry (`skills.json`)
- Agent-First Architecture documentation
