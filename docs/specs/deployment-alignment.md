# Deployment Alignment Spec

**Status**: Draft — awaiting review before implementation  
**Scope**: Docker Desktop (local), Azure AKS, AWS EKS  
**Goal**: Consistent, reproducible deployments across all three environments so template adopters can reason about one mental model and have a clean onramp for both brownfield and greenfield targets.

---

## Design Principles

1. **Single source of truth for structure** — `charts/app/values.yaml` defines all keys; environment overlays only override values, never introduce new structure.
2. **Cloud-native ingress, not raw LoadBalancer** — both AWS and Azure should use a managed L7 edge (CloudFront/WAF or AFD) rather than bare LoadBalancer Services. The Service type should be `ClusterIP` in both, with the L7 edge in front.
3. **Secrets always flow through ESO → OpenBao** — no env-specific secrets handling; local dev is the only exception.
4. **Parameterize, don't fork** — when cloud providers differ (storage class, pull auth, ringpop hooks), express the difference as a values key, not a structural divergence.
5. **Template-user changeset is minimal and documented** — a new adopter should only need to change a small, documented set of values to go from template to their own deployment.

---

## Proposed Changes

### 1. Replace `LoadBalancer` Services with `ClusterIP` + Cloud Edge (High Impact)

**Current state:**
- Azure: `type: LoadBalancer` with 63 AFD CIDR annotations on the Service — tight coupling between K8s and AFD IP ranges that will drift.
- AWS: `type: LoadBalancer` with NLB annotations — no L7 protection (no WAF, no HTTPS redirect, no path routing).
- Prod: `type: ClusterIP` + nginx Ingress — already the right shape but not reflected in dev.

**Problem:**
Template users inheriting this will get raw TCP/IP exposure on AWS dev and a brittle CIDR list for Azure dev. The environments look completely different to kubectl.

**Proposed:**
- Change all environments (dev, test, prod) to `type: ClusterIP` in the Service spec.
- For Azure: AFD → AGIC (Application Gateway Ingress Controller) or retain AFD with an Ingress resource pointing to it. The Ingress resource is the stable interface; AFD is the upstream.
- For AWS: Add an AWS Application Load Balancer via AWS Load Balancer Controller (an Ingress, not a raw Service annotation). This gives TLS termination, WAF attach point, and consistent `/health` path routing.
- The values key `frontend.service.type` becomes `ClusterIP` in base `values.yaml`. Cloud-specific Ingress config lives in `values-dev.yaml` and `values-aws-dev.yaml`.
- Document that for brownfield clusters (bring-your-own Ingress), set `frontend.ingress.enabled: true` and supply the className.

**Files to change:**
- `charts/app/values.yaml` — `frontend.service.type: ClusterIP`
- `charts/app/values-dev.yaml` — remove LoadBalancer annotations; add Ingress block for Azure AGIC or AFD
- `charts/app/values-aws-dev.yaml` — remove NLB annotations; add Ingress block for AWS ALB controller
- `charts/app/templates/frontend-service.yaml` — remove cloud-specific annotation logic if currently templated
- Terraform: add `aws_lb_controller` Helm release to `terraform/platform/aws-staging/`

---

### 2. Unify Storage Class via a Values Variable (Medium Impact)

**Current state:**
- Azure uses `managed-premium` (Premium SSD) throughout `charts/postgres`, `charts/supabase`.
- AWS uses `gp2` (standard SSD).
- These are hardcoded in separate values files — the template user must know to change them.

**Problem:**
A brownfield adopter with a custom storage class (e.g. `standard`, `efs-sc`, `azuredisk-standard`) has to grep across multiple chart files to find all occurrences. Also, `gp2` is being deprecated in favor of `gp3` on newer EKS clusters.

**Proposed:**
- Add a top-level `storageClass` key (or `global.storageClass`) to `charts/postgres/values.yaml` and `charts/supabase/values.yaml`.
- Default to `""` (cluster default) in `values.yaml`.
- Set `storageClass: managed-premium` in `values-dev.yaml` and `storageClass: gp3` in `values-aws-dev.yaml`.
- Document the brownfield case: set `storageClass: ""` to inherit the cluster default, or supply a custom class.

**Files to change:**
- `charts/postgres/values.yaml`, `charts/postgres/templates/pvc.yaml`
- `charts/supabase/values.yaml`, any PVC templates
- `charts/app/values-dev.yaml`, `charts/app/values-aws-dev.yaml`

---

### 3. Align Temporal Namespace & Task Queue Naming (Medium Impact)

**Current state:**
- Local docker-compose: namespace `default`, task queue `main`.
- K8s dev/test: namespace `10x-stack-dev`, task queue `10x-stack-dev-main` (namespace-prefixed).
- K8s prod: namespace `<PROD_NAMESPACE>`, task queue `<PROD_NAMESPACE>-main`.

**Problem:**
Local development uses `default`/`main`; K8s uses namespaced values. A developer running tests locally with a K8s task queue name won't hit the local Temporal server's queue. Code that hardcodes `main` will break in staging. Template users will likely miss this and discover it at deploy time.

**Proposed:**
- Align local to use the same namespace and task queue names as dev by exporting `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE` in docker-compose via `.env.temporal.example`.
- Change the base `values.yaml` defaults so the task queue is `{{ .Release.Namespace }}-main` via a helper template, rather than the literal string. This makes the naming convention self-documenting and removes the need to keep two places in sync.
- Document the local override path: `.env.temporal` can override to `default`/`main` for fast local iteration.

**Files to change:**
- `.env.temporal.example` — add `TEMPORAL_NAMESPACE` and `TEMPORAL_TASK_QUEUE` with dev defaults
- `docker-compose.yml` — reference these env vars
- `charts/app/values.yaml` — add note that `taskQueue` should be `{{ namespace }}-main` pattern

---

### 4. Fix Temporal ConfigMap Hook Asymmetry (Medium Impact)

**Current state:**
- Azure values-dev: `configMap.hook.enabled: true`
- AWS values-aws-dev: `configMap.hook.enabled: false`

The hook exists to prevent "FailedMount" during rolling upgrades because Helm may try to update a ConfigMap that pods are already mounting. On AWS it's disabled because a first-run `helm upgrade --install` on a fresh cluster will fail with "ConfigMap already exists" if the hook tries to create it.

**Problem:**
The asymmetry means the AWS upgrade path is missing a safety net. Also the reason for the difference (fresh-cluster behavior) should be fixed at the helm hook level with `--set-string hook.recreate=true` or `helmHook.deletePolicy: before-hook-creation` rather than disabling the feature entirely.

**Proposed:**
- Set `configMap.hook.policy: before-hook-creation` (Helm's `helm.sh/hook-delete-policy` annotation) so the hook deletes any pre-existing ConfigMap before creating. This makes it safe on both fresh installs and upgrades on both clouds.
- Enable `configMap.hook.enabled: true` in `values-aws-dev.yaml`.
- Remove the asymmetry; both clouds use the same hook behavior.

**Files to change:**
- `charts/temporal/templates/` — configmap hook template, add `"helm.sh/hook-delete-policy": "before-hook-creation"` annotation
- `charts/temporal/values-aws-dev.yaml` — `configMap.hook.enabled: true`

---

### 5. Add LLM API Key Path Through ESO (Medium Impact)

**Current state:**
- Local: Full set of LLM provider keys in `.env.temporal` / `.env` (Anthropic, OpenAI, Azure, AWS, Google, OpenRouter, Groq, Mistral, Exa).
- K8s (Azure/AWS): No LLM key management — the keys are expected to already be in the pod's environment, but no ESO ExternalSecret or `secretKeyRef` is defined for them.

**Problem:**
Template users deploying agents or LLM workflows will find that the temporal-worker and ops-api pods have no LLM key injection path in K8s. They must manually create Kubernetes Secrets and patch the deployment, defeating the ESO pattern. This is a common template adoption failure point.

**Proposed:**
- Add an optional `llmKeys` section to `charts/app/values.yaml`:
  ```yaml
  llmKeys:
    enabled: false           # set true when ESO is enabled and keys are in OpenBao
    secretStore: openbao-dev
    path: secret/data/project-template
    keys:
      - name: ANTHROPIC_API_KEY
        property: anthropic_api_key
      - name: OPENAI_API_KEY
        property: openai_api_key
      # etc.
  ```
- When `llmKeys.enabled: true`, render an ExternalSecret that writes a `llm-secrets` K8s Secret, and mount it as `envFrom.secretRef` in the temporal-worker and ops-api Deployments.
- When `false` (local, or not yet configured), no resource is rendered and the pod can still receive keys via a manually-created Secret or local `.env`.
- Add `anthropic_api_key` and `openai_api_key` as the minimum set; others are additive.

**Files to change:**
- `charts/app/values.yaml` — add `llmKeys` block
- `charts/app/templates/llm-external-secret.yaml` — new ExternalSecret template (conditional)
- `charts/app/templates/temporal-worker-deployment.yaml` — add optional `envFrom` for llm-secrets
- `charts/app/templates/ops-api-deployment.yaml` — same
- `charts/app/values-dev.yaml` and `values-aws-dev.yaml` — `llmKeys.enabled: true` with dev OpenBao path

---

### 6. Centralize Registry Configuration for Template Adopters (Medium Impact)

**Current state:**
- `values.yaml`: `frontend.image.repository: "your-org/frontend"` and `temporalWorker.image.repository: "your-org/temporal-worker"` — placeholders.
- `values-dev.yaml`: Full ACR path `acrselfhealstg.azurecr.io/frontend`.
- `values-aws-dev.yaml`: Full ECR path `354918379520.dkr.ecr.us-east-1.amazonaws.com/frontend`.
- A template adopter needs to update the registry prefix in multiple places.

**Problem:**
The top-level `imageRegistry` key exists in `values.yaml` but is only an advisory comment, not used as a prefix in the image resolution logic. Each image has a separate `registry` override. This results in scattered registry references.

**Proposed:**
- Use `imageRegistry` as the effective prefix in all image templates: `{{ .Values.imageRegistry }}/{{ .Values.frontend.image.repository }}`.
- Set `imageRegistry: ""` in base `values.yaml`.
- Set `imageRegistry: acrselfhealstg.azurecr.io` in `values-dev.yaml`.
- Set `imageRegistry: 354918379520.dkr.ecr.us-east-1.amazonaws.com` in `values-aws-dev.yaml`.
- Per-component `image.registry` still overrides for cases where components live in different registries.
- A template adopter changes `imageRegistry` in exactly one place per environment overlay.
- Document the pattern in `README.md` under "Adapting to your registry".

**Files to change:**
- `charts/app/templates/frontend-deployment.yaml`, `temporal-worker-deployment.yaml`, `ops-api-deployment.yaml` — update image reference helper
- `charts/app/values.yaml` — clarify `imageRegistry` usage
- `charts/app/values-dev.yaml` — set `imageRegistry`
- `charts/app/values-aws-dev.yaml` — set `imageRegistry`

---

### 7. Terraform Outputs → Helm Values Pipeline (Medium Impact)

**Current state:**
- `values-dev.yaml` hardcodes the AFD hostname: `10x-stack-dev-gxaehdajdkefama0.a02.azurefd.net`.
- `values-aws-dev.yaml` uses `placeholder.cloudfront.net` and relies on Terraform to inject it.
- The injection mechanism (how Terraform output reaches the Helm values) is documented as "replaced by Terraform" but the wiring isn't explicit in code.

**Problem:**
Azure values file has a real hardcoded hostname — it won't work for a template adopter who provisions a different AFD endpoint. AWS has a placeholder but the injection path isn't explicit. Both clouds should use the same pattern.

**Proposed:**
- Both `values-dev.yaml` (Azure) and `values-aws-dev.yaml` (AWS) should use template placeholders: `REPLACE_ME_FRONTEND_URL`.
- The Terraform `app-instance` module outputs `frontend_url` and `supabase_url`.
- The Terraform module (or a `local-exec` provisioner) writes the resolved values to `charts/app/values-<env>-injected.yaml` that is gitignored.
- The deploy pipeline passes `--values charts/app/values-<env>-injected.yaml` as the final override layer.
- This makes the pattern explicit, both clouds work identically, and no real hostnames are committed to git.
- Alternatively (simpler): the deploy pipeline takes outputs as `--set` flags (already done for digests). Extend this pattern to `frontend.env.supabaseUrl` and similar. Keep the values file as pure-template.

**Files to change:**
- `charts/app/values-dev.yaml` — replace hardcoded AFD hostname with `REPLACE_ME` placeholder
- `charts/app/values-aws-dev.yaml` — same pattern, remove CloudFront placeholder
- `.github/workflows/deploy-dev.yml` — add `--set frontend.env.supabaseUrl=$(terraform output ...)` step
- `terraform/modules/app-instance/outputs.tf` — expose `frontend_url` output (if not already)

---

### 8. Add `values-local-k8s.yaml` for Docker Desktop Kubernetes (Low-Medium Impact)

**Current state:**
There is no Helm values overlay for Docker Desktop's built-in Kubernetes (distinct from docker-compose). Template users who want to test K8s manifests locally before pushing to AKS/EKS have no ready-made overlay and will use the cloud dev files, which reference external registries and ESO stores that don't exist locally.

**Proposed:**
- Add `charts/app/values-local-k8s.yaml`:
  - `imageRegistry: ""` (uses local images built with `docker build -t frontend:dev-latest`)
  - `imagePullSecrets: []`
  - `externalSecrets.enabled: false` (inline Secrets from `.env`)
  - `frontend.service.type: NodePort` (or ClusterIP + `kubectl port-forward`)
  - `frontend.env.supabaseUrl: http://host.docker.internal:54321`
  - `temporalWorker.temporal.address: temporal-frontend.temporal.svc.cluster.local:7233` (local Temporal from charts/temporal)
  - Resource limits relaxed (same as dev)
- Document in `README.md`: `helm upgrade --install rental-app charts/app -f charts/app/values-local-k8s.yaml`
- This closes the gap between "docker-compose up" and "deploy to cloud" — local K8s is the dry-run environment.

**Files to create:**
- `charts/app/values-local-k8s.yaml`

---

### 9. Align Worker Health Probe Strategy (Low Impact)

**Current state:**
- Temporal Worker: `exec: kill -0 1` — checks if PID 1 is alive. This is a process-presence check, not a health check.
- Ops API: HTTP `GET /health` — proper health check.
- Frontend: HTTP `GET /` — proper health check.

**Problem:**
`kill -0 1` will pass even if the Temporal connection is broken, the worker is deadlocked, or activity processing has stalled. It will only fail if the process crashes entirely. This means Kubernetes will not restart a wedged worker.

**Proposed:**
- Add a `/health` HTTP endpoint to the Temporal worker that checks: (a) process is alive, (b) Temporal client connection is reachable (non-blocking poll), (c) returns 200 if healthy.
- Change worker liveness probe to HTTP `GET /health` on the worker's HTTP port.
- If adding an HTTP health endpoint to the Python worker is out of scope for now, at minimum change the probe to `exec: python -c "import temporal; ..."` or a lightweight heartbeat script, with a comment explaining why `kill -0 1` is insufficient.
- Align probe timeouts: worker currently has `timeoutSeconds: 10` vs frontend/ops-api `5` — these should be consistent.

**Files to change:**
- `temporal/src/` — add health endpoint (Python FastAPI or simple HTTP server)
- `charts/app/values.yaml` — change `temporalWorker.livenessProbe` and `readinessProbe` to HTTP

---

### 10. Document Brownfield vs Greenfield Onramp (Low Impact, High Value for Template Users)

**Current state:**
The README covers local setup well but doesn't differentiate between:
- **Greenfield**: User provisions everything from scratch with `terraform apply` → Terraform creates cluster, registry, secrets store, then pipeline deploys.
- **Brownfield**: User has an existing cluster, existing registry, possibly existing secrets manager. They want to install the Helm charts without the full Terraform stack.

**Problem:**
Template users in enterprises typically have a brownfield environment. The current setup assumes greenfield (Terraform provisions the cluster). A brownfield user hits friction at every Terraform assumption and may abandon the template.

**Proposed additions to `README.md` or a new `docs/guides/adoption.md`:**
1. **Minimum viable brownfield checklist**: existing cluster + OIDC issuer, namespace, storage class name, registry URL + pull secret, secrets store (or disable ESO and create Secrets manually).
2. **What Terraform is optional**: EKS/AKS cluster provisioning is optional if you BYO cluster. Required: ECR/ACR repo (or BYO), OpenBao/Vault instance (or disable ESO).
3. **Values variables template users must change**: `imageRegistry`, `externalSecrets.secretStoreRef.name`, `storageClass` (new), `frontend.env.supabaseUrl`.
4. **The three `kubectl` commands** that aren't yet Terraform-managed (RBAC manifest, namespace creation, kubeconfig secret) — these should either be Terraformed or documented as the manual bootstrap steps.

**Files to create/change:**
- `docs/guides/adoption.md` (new) or additions to `README.md`

---

## Implementation Priority

| # | Change | Impact | Effort | Dependency |
|---|--------|--------|--------|------------|
| 1 | Replace LoadBalancer with ClusterIP + cloud Ingress | High | High | Terraform (ALB controller for AWS) |
| 5 | Add LLM key path through ESO | High | Medium | OpenBao KV entries |
| 6 | Centralize imageRegistry prefix | High | Low | None |
| 3 | Align Temporal namespace/task queue | Medium | Low | None |
| 4 | Fix configMap hook asymmetry | Medium | Low | None |
| 2 | Unify storage class variable | Medium | Low | None |
| 7 | Terraform outputs → Helm values pipeline | Medium | Medium | Terraform outputs |
| 8 | Add values-local-k8s.yaml | Medium | Low | None |
| 9 | Align worker health probe | Low | Medium | Python worker change |
| 10 | Brownfield/greenfield docs | Low | Low | None |

**Recommended first pass**: items 3, 4, 6, 8 — they are low-effort, no infrastructure dependencies, and directly improve the template-user experience. Together they take the local ↔ K8s gap from "you'll discover mismatches at deploy time" to "it works the same way everywhere."

**Second pass**: items 2, 5, 7 — medium effort, require coordination with Terraform and OpenBao.

**Third pass**: items 1, 9, 10 — high-impact but highest effort or require new infrastructure components.

---

## Out of Scope

- **Istio on AWS**: Adding a service mesh to EKS is a significant infrastructure change. The spec notes the gap (east-west traffic is unencrypted on AWS) but defers the decision to a separate ADR.
- **ESO refresh tuning**: 5-minute refresh is acceptable for now. Secret rotation SLA is a product decision, not a template decision.
- **Multi-tenant Temporal**: Shared Temporal server in dev/test is acceptable for template purposes. Production isolation (separate Temporal cluster per environment) is out of scope.
