# Changelog

All notable changes to Cortex AI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-05-29

### Added
- 🎉 **Initial public release of Cortex AI**
- **Hierarchical AI orchestration** with three-tier system (Worker/IC/Manager)
- **Multi-provider support** for Claude (Opus/Sonnet/Haiku) and OpenAI (GPT-4o/GPT-4/GPT-4o-mini)
- **Smart routing** based on task complexity and confidence scoring
- **Automatic escalation** when models need help from higher tiers
- **Load balancing** across AI providers (50/50 split when both available)
- **Session persistence** with automatic conversation resumption
- **Zero dependencies** - uses only Node.js built-in modules
- **CLI detection** for existing Claude CLI and OpenAI CLI setups
- **Interactive REPL** with command history and helpful commands
- **System health checks** via `--doctor` flag
- **Transparent logging** of all model decisions and escalations

### Features
- **Worker Tier**: Handles simple tasks (file searches, formatting, info lookup)
- **IC Tier**: Manages most development work (coding, refactoring, testing)
- **Manager Tier**: Oversees complex decisions (architecture, security, debugging)
- **Confidence-based escalation**: Models self-assess and escalate when uncertain
- **Provider failover**: Automatically switches providers if one is unavailable
- **Local privacy**: All processing uses your existing AI subscriptions
- **Cross-platform support**: Works on macOS, Linux, and Windows (WSL)

### CLI Commands
- `npx cortex-ai` - Start interactive AI organization
- `npx cortex-ai --doctor` - Comprehensive system health check
- `npx cortex-ai --help` - Show usage information
- `npx cortex-ai --version` - Display version information

### REPL Commands
- `/help` - Show available commands
- `/status` - Current provider status and model availability
- `/clear` - Clear conversation history
- `/reset` - Reset session state
- `/quit` - Exit Cortex

### Technical Details
- **Node.js requirement**: 20.0.0 or higher
- **Package size**: Lightweight (~100KB installed)
- **Memory usage**: ~50MB RAM typical usage
- **Session storage**: `.cortex/sessions/` directory for conversation history
- **Configuration**: Environment variables for customization

### Documentation
- Comprehensive README with installation and usage examples
- Troubleshooting guide for common setup issues
- Contributing guidelines for community development
- MIT license for open source usage

---

## Development History

This release represents the culmination of three development phases:

**Phase 1**: Core orchestration engine and CLI detection
**Phase 2**: Enhanced confidence scoring and manager review patterns  
**Phase 3**: UX polish, error handling, and production readiness

The codebase is designed for reliability, maintainability, and extensibility as we grow the Cortex ecosystem.