# Quick Reference - Common Commands

Essential commands for working with Flux CD and Kubernetes deployments.

---

## 🚀 Flux Commands

### Check Flux Status
```bash
# Check if Flux is installed and healthy
flux check

# View all Flux resources
flux get all

# View kustomizations status
flux get kustomizations

# View Git sources
flux get sources git
```

### Force Reconciliation
```bash
# Force Flux to sync immediately (don't wait for poll interval)
flux reconcile kustomization flux-system --with-source

# Reconcile specific kustomization
flux reconcile kustomization artifactory-mcp-server
```

### View Flux Logs
```bash
# Source controller logs
kubectl logs -n flux-system deployment/source-controller -f

# Kustomize controller logs
kubectl logs -n flux-system deployment/kustomize-controller -f

# All Flux pods
kubectl logs -n flux-system --all-containers -f
```

---

## 🔍 Kubernetes Commands

### View Deployments
```bash
# List all pods in namespace
kubectl get pods -n artifactory-mcp-server

# Watch pods in real-time
kubectl get pods -n artifactory-mcp-server --watch

# Get deployment details
kubectl get deployment artifactory-mcp-server -n artifactory-mcp-server

# View deployment with full details
kubectl describe deployment artifactory-mcp-server -n artifactory-mcp-server
```

### View Logs
```bash
# View logs for all pods with label
kubectl logs -n artifactory-mcp-server -l app=artifactory-mcp-server

# Follow logs in real-time
kubectl logs -n artifactory-mcp-server -l app=artifactory-mcp-server -f

# View logs for specific pod
kubectl logs -n artifactory-mcp-server POD_NAME

# View previous container logs (if pod crashed)
kubectl logs -n artifactory-mcp-server POD_NAME --previous
```

### Check Service
```bash
# Get service details
kubectl get svc artifactory-mcp-server -n artifactory-mcp-server

# Describe service
kubectl describe svc artifactory-mcp-server -n artifactory-mcp-server

# Port forward to test locally
kubectl port-forward -n artifactory-mcp-server svc/artifactory-mcp-server 8080:80
```

### Check Events
```bash
# View recent events
kubectl get events -n artifactory-mcp-server --sort-by='.lastTimestamp'

# Watch events in real-time
kubectl get events -n artifactory-mcp-server --watch
```

---

## 🔐 Secret Management

### Check Secrets
```bash
# List secrets
kubectl get secrets -n artifactory-mcp-server

# View ExternalSecret status
kubectl get externalsecret -n artifactory-mcp-server

# Describe ExternalSecret
kubectl describe externalsecret artifactory-credentials -n artifactory-mcp-server

# Check SecretStore
kubectl get secretstore -n artifactory-mcp-server
kubectl describe secretstore gcp-secret-store -n artifactory-mcp-server
```

### View Secret Contents (Debug)
```bash
# View secret data (base64 encoded)
kubectl get secret artifactory-credentials -n artifactory-mcp-server -o yaml

# Decode secret value
kubectl get secret artifactory-credentials -n artifactory-mcp-server -o jsonpath='{.data.ARTIFACTORY_BASE_URL}' | base64 -d
```

---

## 🔄 Deployment Operations

### Rollout Status
```bash
# Check deployment rollout status
kubectl rollout status deployment/artifactory-mcp-server -n artifactory-mcp-server

# View rollout history
kubectl rollout history deployment/artifactory-mcp-server -n artifactory-mcp-server
```

### Rollback
```bash
# Rollback to previous version
kubectl rollout undo deployment/artifactory-mcp-server -n artifactory-mcp-server

# Rollback to specific revision
kubectl rollout undo deployment/artifactory-mcp-server -n artifactory-mcp-server --to-revision=2
```

### Restart Deployment
```bash
# Restart all pods (rolling restart)
kubectl rollout restart deployment/artifactory-mcp-server -n artifactory-mcp-server
```

### Scale Deployment
```bash
# Scale to 3 replicas
kubectl scale deployment artifactory-mcp-server -n artifactory-mcp-server --replicas=3

# Scale to 1 replica
kubectl scale deployment artifactory-mcp-server -n artifactory-mcp-server --replicas=1
```

---

## 🧪 Testing and Debugging

### Execute Commands in Pod
```bash
# Get shell access to pod
kubectl exec -it -n artifactory-mcp-server POD_NAME -- /bin/sh

# Run specific command
kubectl exec -n artifactory-mcp-server POD_NAME -- python --version
```

### Test MCP Server
```bash
# Port forward to local machine
kubectl port-forward -n artifactory-mcp-server svc/artifactory-mcp-server 8080:80

# In another terminal, test endpoint
curl -H "Accept: text/event-stream" http://localhost:8080/mcp
```

### Check Image
```bash
# Get current image tag
kubectl get deployment artifactory-mcp-server -n artifactory-mcp-server -o jsonpath='{.spec.template.spec.containers[0].image}'

# Get image for all pods
kubectl get pods -n artifactory-mcp-server -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
```

---

## 🐛 Troubleshooting

### Pod Not Starting
```bash
# Check pod status
kubectl get pods -n artifactory-mcp-server

# Describe pod for events
kubectl describe pod -n artifactory-mcp-server POD_NAME

# Check logs
kubectl logs -n artifactory-mcp-server POD_NAME

# Check if image can be pulled
kubectl get events -n artifactory-mcp-server | grep -i pull
```

### Secrets Not Working
```bash
# Check if secret exists
kubectl get secret artifactory-credentials -n artifactory-mcp-server

# Check ExternalSecret status
kubectl describe externalsecret artifactory-credentials -n artifactory-mcp-server

# Check External Secrets Operator logs
kubectl logs -n external-secrets-system -l app.kubernetes.io/name=external-secrets
```

### Flux Not Syncing
```bash
# Check Flux status
flux get all

# Check Git source
flux get sources git

# Check for errors in logs
kubectl logs -n flux-system deployment/source-controller
kubectl logs -n flux-system deployment/kustomize-controller

# Force reconciliation
flux reconcile source git flux-system
flux reconcile kustomization flux-system
```

---

## 📊 Monitoring

### Resource Usage
```bash
# View pod resource usage
kubectl top pods -n artifactory-mcp-server

# View node resource usage
kubectl top nodes
```

### Health Checks
```bash
# Check if pod is ready
kubectl get pods -n artifactory-mcp-server -o wide

# View pod conditions
kubectl get pods -n artifactory-mcp-server -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.conditions[*].type}{"\n"}{end}'
```

---

## 🔧 GCP Commands

### Artifact Registry
```bash
# List images in registry
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/PROJECT_ID/REPOSITORY

# List tags for specific image
gcloud artifacts docker tags list \
  us-central1-docker.pkg.dev/PROJECT_ID/REPOSITORY/artifactory-mcp-server
```

### Secret Manager
```bash
# List secrets
gcloud secrets list

# Get secret value
gcloud secrets versions access latest --secret="artifactory-base-url"

# Create/update secret
echo -n "new-value" | gcloud secrets create secret-name --data-file=-
```

### GKE Cluster
```bash
# Get cluster credentials
gcloud container clusters get-credentials CLUSTER_NAME \
  --region us-central1 \
  --project PROJECT_ID

# List clusters
gcloud container clusters list

# Get cluster info
kubectl cluster-info
```

---

## 🚀 Quick Deploy Workflow

```bash
# 1. Make code changes locally
git checkout -b feature/my-change
# ... edit server.py ...
git commit -m "Add new feature"
git push origin feature/my-change

# 2. Create PR and merge (GitHub UI)

# 3. Watch deployment
kubectl get pods -n artifactory-mcp-server --watch

# 4. Check Flux status
flux get kustomizations

# 5. Verify deployment
kubectl logs -n artifactory-mcp-server -l app=artifactory-mcp-server

# 6. Test endpoint
kubectl port-forward -n artifactory-mcp-server svc/artifactory-mcp-server 8080:80
curl -H "Accept: text/event-stream" http://localhost:8080/mcp
```

---

## 📚 More Information

- **Setup Guide:** [../FLUX_SETUP_GUIDE.md](../FLUX_SETUP_GUIDE.md)
- **Flow Diagram:** [../FLUX_FLOW_DIAGRAM.md](../FLUX_FLOW_DIAGRAM.md)
- **K8s Guide:** [README.md](README.md)
- **CircleCI Guide:** [../.circleci/README.md](../.circleci/README.md)
