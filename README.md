# Lambda MicroVM Web Apps

This fork keeps the original samples and adds a personal, on-demand OMP Cloud IDE implementation under [`code-server/`](code-server/README.md).

The Cloud IDE is customized for `har1101` and uses:

- Lambda MicroVMs in `ap-northeast-1`
- CloudFront and Lambda@Edge in `us-east-1`
- code-server, pinned OMP, Bun, Node.js, Python/uv, GitHub CLI, and AWS CLI
- OMP goal/ask defaults with yolo approvals and explicit destructive-command denies
- encrypted S3 persistence for OMP and GitHub OAuth state
- CloudFront-side password form with a signed, `HttpOnly` session cookie before `RunMicrovm`
- `cdkd` as the dev/test deployment engine

No credentials or personal access tokens are committed to this repository.
