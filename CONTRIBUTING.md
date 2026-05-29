# Contributing to Cortex AI

Thank you for your interest in contributing to Cortex AI! This document provides guidelines for contributing to our open source hierarchical AI orchestration tool.

## 🚀 Quick Start

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/your-username/cortex-ai.git
   cd cortex-ai
   ```
3. **Test the installation**:
   ```bash
   node src/cli.mjs --doctor
   ```

## 🎯 Ways to Contribute

### 🐛 Bug Reports
- Use GitHub Issues with the "bug" label
- Include system info (`node --version`, OS, AI provider setup)
- Provide reproduction steps and expected vs actual behavior
- Include relevant log output from `--verbose` mode

### 💡 Feature Requests  
- Use GitHub Issues with the "enhancement" label
- Describe the use case and expected benefit
- Consider if it fits the hierarchical orchestration philosophy
- Discuss implementation approach if you have ideas

### 📖 Documentation
- Improve README, inline comments, or examples
- Add use case tutorials or troubleshooting guides
- Fix typos or clarify confusing sections

### 🔧 Code Contributions
- Fix bugs, improve performance, add features
- Follow the architecture patterns below
- Include tests for new functionality
- Update documentation for API changes

## 🏗️ Architecture Overview

Cortex AI is built with a clean separation of concerns:

```
src/
├── cli.mjs              # Entry point, argument parsing
├── repl.mjs             # Interactive shell and conversation loop  
├── chef.mjs             # Core orchestration engine
├── orchestrator/        # Hierarchical routing logic
│   ├── classify.mjs     # Task analysis and risk assessment
│   ├── confidence.mjs   # Confidence scoring and parsing
│   ├── handoffs.mjs     # Escalation tracking and audit
│   └── review.mjs       # Manager review patterns
├── providers/           # AI provider integrations
│   ├── claude.mjs       # Claude CLI subprocess management
│   ├── codex.mjs        # OpenAI Codex CLI integration
│   ├── detect.mjs       # Provider discovery and auth checking
│   ├── select.mjs       # Intelligent provider selection
│   └── balance.mjs      # Load balancing logic
├── state/               # Local state management
│   ├── session.mjs      # Conversation persistence
│   ├── atomic.mjs       # Safe file operations
│   └── recovery.mjs     # Session recovery and cleanup
└── ui/                  # Terminal user interface
    ├── formatter.mjs    # Output formatting and colors
    ├── progress.mjs     # Progress indicators
    └── errors.mjs       # Error display and recovery
```

## 🎨 Design Principles

### 1. **Zero Dependencies**
- Use only Node.js built-in modules (no npm dependencies)
- Keep installation instant and eliminate supply-chain risk
- Prefer simple, direct implementations over complex abstractions

### 2. **Hierarchical Orchestration**
- Workers handle simple tasks (file ops, grep, formatting)
- ICs handle main implementation work (coding, debugging)  
- Managers handle complex decisions (architecture, security)
- Models escalate UP when uncertain, delegate DOWN when appropriate

### 3. **Transparency First**
- Users always see which model is working and why
- Show confidence levels, escalation reasons, and routing decisions
- Make the AI org chart visible and understandable

### 4. **Graceful Degradation**
- Work with Claude-only, OpenAI-only, or both providers
- Fallback to single-provider self-critique when needed
- Handle auth failures, network issues, and CLI problems gracefully

### 5. **Local First**
- All data stays on user's machine
- Use existing user subscriptions (no proxy/sharing)
- Session persistence survives crashes and restarts

## 💻 Development Guidelines

### Code Style

- **ES Modules**: Use `import`/`export`, not `require()`
- **Async/Await**: Prefer async/await over promise chains
- **Error Handling**: Always handle errors with helpful messages
- **Comments**: Focus on WHY, not what (code should be self-documenting)

### File Organization

- **One responsibility per file**: Each module should have a clear, single purpose
- **Consistent naming**: Use kebab-case for files, camelCase for variables
- **Clear exports**: Export only what's needed, prefer named exports
- **No circular dependencies**: Keep imports flowing in one direction

### Subprocess Management

```javascript
// Good: Proper subprocess handling
const result = spawnSync(claudeBin, ['-m', model, '-p', prompt], {
  encoding: 'utf8',
  timeout: 120_000,
  stdio: ['pipe', 'pipe', 'pipe']
});

if (result.error) {
  throw new ProviderError(`Claude CLI failed: ${result.error.message}`);
}

// Bad: No error handling or timeout
const result = spawnSync('claude', [prompt]);
```

### State Management

```javascript
// Good: Atomic operations
import { atomicWriteJSON } from './state/atomic.mjs';

await atomicWriteJSON('.cortex/session.json', sessionData);

// Bad: Race conditions possible
import { writeFileSync } from 'fs';
writeFileSync('.cortex/session.json', JSON.stringify(sessionData));
```

## 🧪 Testing

### Manual Testing
```bash
# Test CLI detection
node src/cli.mjs --doctor

# Test basic orchestration  
node src/cli.mjs

# Test with single provider
export CORTEX_FORCE_CLAUDE=true
node src/cli.mjs

# Test error recovery
# (disconnect internet, expire tokens, etc.)
```

### Integration Testing
```bash
# Test package installation
npm pack
npm install -g cortex-ai-*.tgz
cortex --version

# Test cross-platform
# (Windows, macOS, Linux)
```

### Performance Testing
```bash
# Test with large sessions
# (generate large .cortex/sessions/current.jsonl)

# Test memory usage
node --trace-gc src/cli.mjs

# Test with slow network
# (simulate high latency to API providers)
```

## 📝 Pull Request Process

### Before Submitting
1. **Test thoroughly** with both Claude and OpenAI setups
2. **Update documentation** for any API changes
3. **Follow code style** and architectural patterns
4. **Check for regressions** in existing functionality

### PR Description Template
```markdown
## Summary
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)  
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
- [ ] Tested with Claude-only setup
- [ ] Tested with OpenAI-only setup  
- [ ] Tested with dual-provider setup
- [ ] Tested error conditions and recovery
- [ ] Updated documentation if needed

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] My changes generate no new warnings
- [ ] Any dependent changes have been merged and published
```

### Review Process
1. **Automated checks**: Code style, basic functionality
2. **Maintainer review**: Architecture, performance, edge cases
3. **Community feedback**: Open to all contributors
4. **Testing**: Cross-platform verification before merge

## 🏷️ Release Process

### Version Numbers
- **1.x.y**: Major version (breaking changes)
- **x.1.y**: Minor version (new features, backward compatible)
- **x.x.1**: Patch version (bug fixes, no new features)

### Release Checklist
- [ ] All tests pass
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Version bumped in package.json
- [ ] Tagged release in git
- [ ] Published to npm

## 🤝 Community

### Getting Help
- **GitHub Discussions**: General questions and ideas
- **GitHub Issues**: Bug reports and feature requests
- **Email**: hello@heyvera.org for private inquiries

### Code of Conduct
- **Be respectful** and inclusive in all interactions
- **Focus on what's best** for the community and project
- **Show empathy** towards other community members
- **Accept constructive feedback** gracefully

### Recognition
Contributors will be:
- Listed in CHANGELOG.md for their contributions
- Added to package.json contributors field
- Recognized in release notes for significant contributions

## 🚀 Advanced Contributing

### Adding New AI Providers
1. Create provider module in `src/providers/`
2. Implement standard interface: `detect()`, `execute()`, `healthCheck()`
3. Add to provider registry in `src/providers/select.mjs`
4. Update documentation and examples

### Adding New Orchestration Patterns
1. Study existing patterns in `src/patterns/`
2. Implement new pattern following same interface
3. Add routing logic in `src/orchestrator/recipe.mjs`
4. Add tests and documentation

### Performance Optimization
- Profile with `node --prof` and `node --trace-opt`
- Focus on subprocess startup time and memory usage
- Optimize JSON parsing and file I/O operations
- Consider caching for expensive operations

## 📚 Resources

- **Node.js Subprocess**: [child_process documentation](https://nodejs.org/api/child_process.html)
- **Claude CLI**: [Anthropic CLI documentation](https://docs.anthropic.com/claude/docs/cli)
- **OpenAI CLI**: [OpenAI CLI documentation](https://platform.openai.com/docs/api-reference/cli)
- **Terminal Colors**: [ANSI escape codes](https://en.wikipedia.org/wiki/ANSI_escape_code)

---

Thank you for contributing to Cortex AI! Together we're making AI orchestration accessible to everyone. 🎉