# Quick Start: feat/2.4.2-ui-preserved-new-features

## Branch Information
- **Branch Name**: `feat/2.4.2-ui-preserved-new-features`
- **Base Version**: v2.4.2 (commit `160bfa8`)
- **Status**: Ready for development

## Setup

```bash
# Navigate to claude-relay directory
cd ~/projects/claude-relay

# Checkout the branch
git checkout feat/2.4.2-ui-preserved-new-features

# Install dependencies (if needed)
npm install

# Start development server
npm run dev
```

## Development Workflow

### 1. Creating Feature Branches
```bash
# From this branch, create feature branches
git checkout -b feat/feature-name

# Example:
git checkout -b feat/ultra-pilot-integration
git checkout -b feat/zai-model-support
```

### 2. Testing Changes
```bash
# Run in development mode
npm run dev

# Or run production build
npm start
```

### 3. Merging Features Back
```bash
# Merge feature branch into this branch
git checkout feat/2.4.2-ui-preserved-new-features
git merge feat/feature-name
```

## Key Files to Understand

### Core Application Files
- `lib/pages.js` - Main application pages and UI logic
- `lib/project.js` - Project management
- `lib/sessions.js` - Session handling
- `lib/sdk-bridge.js` - Claude SDK integration
- `lib/daemon.js` - Background daemon
- `lib/server.js` - Web server

### UI Files
- `lib/public/index.html` - Main HTML structure
- `lib/public/app.js` - Frontend application logic
- `lib/public/css/` - Stylesheets
- `lib/public/modules/` - JavaScript modules

### Configuration
- `lib/config.js` - Configuration management
- `lib/themes/` - Theme definitions

## UI Preservation Guidelines

### DO ✅
- Add new features as separate modules
- Use overlay/slide-out panels for new UI
- Extend existing components
- Add new menu items or buttons
- Create new pages/sections
- Use feature flags

### DON'T ❌
- Modify existing sidebar layout
- Change theme system structure
- Alter existing component styling
- Remove or rename existing features
- Change responsive breakpoints
- Modify core CSS framework

## Testing Checklist

Before merging any feature:
- [ ] Existing UI still looks correct
- [ ] All themes work properly
- [ ] Mobile responsive design maintained
- [ ] No console errors
- [ ] All existing features work
- [ ] New feature is tested
- [ ] Performance is not degraded

## Current UI Components (v2.4.2)

### Sidebar
- Inline project list
- Pinned sections (Tools, Sessions)
- Session search
- New session/project buttons
- Project management (add/remove)

### Main Interface
- Chat interface
- File browser with Material icons
- Terminal tabs
- Tool call grouping
- Sub-agent activity display
- Theme picker

### Features
- CLI session picker
- Headless mode
- Push notifications
- PWA support
- One-click updates
- Mermaid diagram rendering

## Next Development Steps

1. **Choose a feature** from BRANCH_PLAN.md
2. **Create a feature branch**
3. **Implement the feature** following UI preservation guidelines
4. **Test thoroughly**
5. **Merge back** to this branch

## Getting Help

- Review `BRANCH_PLAN.md` for detailed strategy
- Check `CHANGELOG.md` for v2.4.2 features
- Read `README.md` for project overview
- Examine existing code patterns in `lib/` directory

## Branch Management

```bash
# Check current branch
git branch

# Compare with main
git diff main

# See commits unique to this branch
git log main..HEAD --oneline

# Push to remote (if needed)
git push -u origin feat/2.4.2-ui-preserved-new-features
```

---
*Happy coding! Remember: Preserve the UI, extend the functionality.*