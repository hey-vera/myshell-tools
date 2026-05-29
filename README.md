# Cortex AI

[![npm version](https://badge.fury.io/js/cortex-ai.svg)](https://badge.fury.io/js/cortex-ai)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

```
 ██████╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗
██╔════╝██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝
██║     ██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ 
██║     ██║   ██║██╔══██╗   ██║   ██╔══╝   ██╔██╗ 
╚██████╗╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗
 ╚═════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
```

**Hierarchical AI orchestration for your shell**

Transform your existing Claude/GPT subscriptions into an intelligent AI organization. No new accounts needed.

## Quick Start

```bash
# Install and run immediately
npx cortex-ai

# Check your AI providers
npx cortex-ai --doctor
```

That's it! Cortex detects your existing Claude CLI and OpenAI setups automatically.

## What is Cortex?

Cortex creates a **hierarchical AI organization** in your shell where AI models work together like a company org chart. Instead of always using the most expensive model, tasks flow through appropriate tiers:

```
👤 You
 │
 ├── 👨‍💻 IC (Sonnet/GPT-4) ← Most tasks start here
 │    ├── ⬇️  DELEGATE → 🏗️  Worker (Haiku/GPT-4-mini)
 │    │                    └── Simple: grep, format, info lookup
 │    └── ⬆️  ESCALATE → 👔 Manager (Opus/GPT-4-o)
 │                        └── Complex: architecture, security, debugging
 └── 🔄 Smart routing based on confidence and complexity
```

**Result**: Better decisions + lower costs + transparent reasoning.

## The AI Hierarchy Explained

### 🏗️ **Worker Tier** (Efficient Execution)
- **Models**: Claude Haiku, GPT-4o-mini
- **Perfect for**: File searches, code formatting, running tests, simple queries
- **Escalates when**: Task requires reasoning or code changes
- **Cost**: Lowest tier, handles 30% of simple tasks

### 👨‍💻 **IC Tier** (Individual Contributor) 
- **Models**: Claude Sonnet, GPT-4
- **Perfect for**: Implementation, refactoring, bug fixes, most coding work
- **Escalates when**: Low confidence (<50%), complex architecture, security concerns
- **Cost**: Medium tier, handles 60% of development tasks

### 👔 **Manager Tier** (Strategic Oversight)
- **Models**: Claude Opus, GPT-4o
- **Perfect for**: Architecture decisions, security reviews, complex debugging
- **Never escalates**: Top of the hierarchy, final authority
- **Cost**: Premium tier, handles 10% of critical decisions

## Installation & Requirements

**Prerequisites**: You need at least one AI CLI installed and authenticated:

### Claude CLI Setup
```bash
# Install Claude CLI
pip install claude-ai-cli

# Authenticate with your Anthropic account
claude auth login
```

### OpenAI CLI Setup  
```bash
# Install OpenAI CLI
npm install -g @openai/openai-cli

# Authenticate with your OpenAI account
openai auth login
```

### System Requirements
- **Node.js**: 20.0.0 or higher
- **Operating System**: macOS, Linux, Windows (WSL recommended)
- **Memory**: 100MB RAM
- **Dependencies**: Zero npm dependencies (uses only Node.js builtins)

## Usage Examples

### Basic Interaction
```bash
$ npx cortex-ai

🧠 Cortex v1.0.0
AI Org Chart Active
├─ Claude (Opus/Sonnet/Haiku) ✅
└─ OpenAI (GPT-4o/GPT-4/GPT-4o-mini) ✅

❯ refactor the auth system to use JWT tokens

🔄 IC (Sonnet): Analyzing authentication architecture...
  ├─ DELEGATE → Worker (Haiku): mapping auth files
  │  └─ Found 12 auth-related files ✅ (confidence: 0.9)
  └─ ESCALATE → Manager (Opus): security-critical refactor
     └─ Manager: Recommending incremental JWT migration ✅

✅ Completed by MANAGER (Opus)
🎯 Confidence: 92% | 🔄 Escalations: 1
```

### Complex Task Handling
```bash
❯ optimize this database query for better performance

🔄 IC (GPT-4): Analyzing query performance...
  ├─ Current query uses inefficient joins
  ├─ DELEGATE → Worker: analyze query execution plan  
  │  └─ Worker: Found 3 missing indexes ✅
  └─ IC: Proposed optimized query with proper indexing ✅

✅ Completed by IC (GPT-4)  
🎯 Confidence: 87% | 🔄 No escalation needed
```

### System Health Check
```bash
$ npx cortex-ai --doctor

🔍 Cortex System Health Check

Provider Status:
✅ Claude CLI: Authenticated (3 models available)
   ├─ claude-3-opus-20240229 (Manager tier)
   ├─ claude-3-sonnet-20240229 (IC tier) 
   └─ claude-3-haiku-20240307 (Worker tier)

✅ OpenAI CLI: Authenticated (3 models available)
   ├─ gpt-4o (Manager tier)
   ├─ gpt-4 (IC tier)
   └─ gpt-4o-mini (Worker tier)

System Status:
✅ Node.js 20.2.0 (compatible)
✅ Directory permissions (read/write access)
✅ Session storage (.cortex/ directory)
✅ All prompt templates loaded

🎉 System ready for hierarchical AI orchestration!
```

## Advanced Features

### Smart Load Balancing
Cortex automatically balances work across providers:
- **50/50 split**: Equal distribution between Claude and OpenAI when both available  
- **Failover**: Automatically switches providers if one is unavailable
- **Cost optimization**: Prefers cheaper models when confidence is high

### Session Persistence
All conversations auto-save to `.cortex/sessions/current.jsonl`:
```bash
cd my-project
npx cortex-ai  # Automatically resumes project context
```

### Interactive Commands
Inside Cortex REPL:
- `/help` - Show available commands
- `/status` - Current provider balance and model availability
- `/clear` - Clear conversation history  
- `/reset` - Reset session state
- `/quit` - Exit Cortex

## Configuration

Cortex works zero-config, but you can customize behavior:

### Custom Model Preferences
```bash
# Prefer Claude for coding tasks
export CORTEX_PREFER_CLAUDE=true

# Prefer OpenAI for creative tasks  
export CORTEX_PREFER_OPENAI=true
```

### Confidence Thresholds
```bash
# Higher escalation threshold (more conservative)
export CORTEX_ESCALATION_THRESHOLD=0.7

# Lower escalation threshold (more aggressive delegation)
export CORTEX_ESCALATION_THRESHOLD=0.3
```

## Troubleshooting

### "No AI providers detected"
```bash
# Check authentication status
claude auth status
openai auth status

# Re-authenticate if needed
claude auth login
openai auth login
```

### "Permission denied" errors
```bash
# Ensure Node.js permissions
chmod +x ~/.local/bin/cortex

# Check directory permissions
ls -la .cortex/
```

### Provider-specific issues
```bash
# Test Claude connection
claude chat "Hello, can you respond?"

# Test OpenAI connection  
openai chat "Hello, can you respond?"

# Run full system check
npx cortex-ai --doctor
```

### Performance Issues
```bash
# Clear session cache
rm -rf .cortex/sessions/

# Reset to defaults
npx cortex-ai --reset
```

## Why Hierarchical AI?

### Traditional Approach Problems
- ❌ Every task burns expensive premium model tokens
- ❌ Simple tasks get over-engineered solutions  
- ❌ No transparency into decision-making process
- ❌ High costs for routine work

### Cortex Approach Benefits
- ✅ **Cost Efficient**: 80% of tasks complete at IC tier or below
- ✅ **Better Quality**: Managers review complex/security-critical work
- ✅ **Transparent**: See exactly which model handled what and why
- ✅ **Adaptive**: Automatically escalates when confidence is low
- ✅ **Local Privacy**: Uses your existing subscriptions, no data sharing

## Contributing

We welcome contributions! This is a community-driven project.

### Development Setup
```bash
git clone https://github.com/heyvera/cortex-ai.git
cd cortex-ai
npm install
npm start
```

### Architecture Overview
- **`src/cli.mjs`**: Main entry point and argument parsing
- **`src/orchestrator/`**: Hierarchical routing and escalation logic
- **`src/providers/`**: Claude and OpenAI CLI integration
- **`src/repl.mjs`**: Interactive shell implementation
- **`templates/`**: Prompt templates for each tier

### Contributing Guidelines
1. **Issues**: Report bugs or suggest features via GitHub Issues
2. **Pull Requests**: Fork, create feature branch, submit PR
3. **Code Style**: Follow existing patterns, use ESLint
4. **Testing**: Test with both Claude and OpenAI setups
5. **Documentation**: Update README for new features

## Roadmap

### v1.1 (Next Release)
- [ ] Plugin system for custom AI providers
- [ ] Team collaboration features
- [ ] Advanced analytics and usage tracking
- [ ] Custom prompt template management

### v1.2 (Future)
- [ ] Web dashboard for session management
- [ ] Integration with VS Code extension
- [ ] Multi-project workspace support
- [ ] Advanced caching and performance optimization

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Documentation**: [GitHub Wiki](https://github.com/heyvera/cortex-ai/wiki)
- **Issues**: [GitHub Issues](https://github.com/heyvera/cortex-ai/issues)
- **Discussions**: [GitHub Discussions](https://github.com/heyvera/cortex-ai/discussions)
- **Email**: hello@heyvera.org

---

**Made with ❤️ by the HeyVera team**

*Cortex AI: Where artificial intelligence meets organizational intelligence.*