---
"@duraxis/cli": patch
---

Resolve installed dependency metadata from the selected application's node_modules tree, including hoisted and linked packages, and use the PnP resolver only for active PnP installations. Prevent dependencies available only to CLI tooling or test loaders from being mistaken for application installations and suppressing requested upgrades.
