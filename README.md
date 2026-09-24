# Lambda MicroVM Web Apps

This fork keeps the original samples and adds a personal, on-demand OMP Cloud IDE implementation under [`code-server/`](code-server/README.md).

The Cloud IDE is customized for `har1101` and uses:

- Lambda MicroVMs in `ap-northeast-1`
- CloudFront and Lambda@Edge in `us-east-1`
- code-server, pinned OMP, Bun, Node.js, Python/uv, GitHub CLI, and AWS CLI
- OMP goal/ask defaults with yolo approvals and explicit destructive-command denies
- an OMP browser E2E runtime with preinstalled arm64 headless Chromium and screenshot artifacts
- encrypted S3 persistence for OMP and GitHub OAuth state
- CloudFront-side password form with a signed, `HttpOnly` session cookie before `RunMicrovm`
- an explicit suspend/resume control that prevents editor reconnects from waking a paused MicroVM
- an authenticated session chooser for reconnecting to an existing MicroVM or starting a new one
- `cdkd` as the dev/test deployment engine

## Documentation

- [Architecture, design principles, IaC, and external modules](docs/architecture-and-design.md)
- [Implementation status, gaps, and improvement roadmap](docs/implementation-status-and-roadmap.md)
- [Lessons learned, pitfalls, and operational cautions](docs/lessons-learned.md)
- [Session-management details](docs/session-management.md)

No credentials or personal access tokens are committed to this repository.
