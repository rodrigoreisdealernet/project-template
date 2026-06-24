# ADR-0123: Helm chart imageRegistry defaults to centralized registry prefix overrides

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Copilot (implementation), platform-engineer review
- **Supersedes / Superseded by:** none

## Context

The app chart has a global `imageRegistry` value and per-component `image.registry` overrides. Template adopters should be able to repoint all component images to their own registry with one environment-level override, while still preserving component-specific override capability for split-registry cases.

The deployment-alignment spec item 6 requires setting concrete environment defaults for Azure and AWS overlays so adopters do not need to edit each image block separately.

## Decision

We keep `imageRegistry` as the default global prefix and set environment defaults directly in chart overlays: `acrselfhealstg.azurecr.io` in `values-dev.yaml` and `354918379520.dkr.ecr.us-east-1.amazonaws.com` in `values-aws-dev.yaml`, with base `values.yaml` retaining `imageRegistry: ""` for template portability.

## Consequences

- **Easier:** A template adopter can change one key per environment (`imageRegistry`) to redirect all standard workload images.
- **Easier:** Existing per-component `image.registry` remains available for mixed-registry deployments.
- **Trade-off accepted:** Environment overlays now carry concrete registry defaults, so adopters should update those values during fork/bootstrap.

## Alternatives considered

- **Keep registry embedded in each `image.repository`:** rejected because it forces repetitive edits across multiple component values.
- **Require deploy-time `--set imageRegistry=...` only:** rejected because defaults in environment overlays are clearer for template adopters and local render/debug workflows.

## Evidence

- `charts/app/templates/_helpers.tpl` (`app.image`) — resolves per-component registry override first, then global `imageRegistry`.
- `charts/app/values.yaml` — documents empty-string behavior for `imageRegistry`.
- `charts/app/values-dev.yaml` — sets `imageRegistry: "acrselfhealstg.azurecr.io"`.
- `charts/app/values-aws-dev.yaml` — sets `imageRegistry: "354918379520.dkr.ecr.us-east-1.amazonaws.com"`.
- `docs/specs/deployment-alignment.md` item 6 — source requirement for centralized registry configuration.
