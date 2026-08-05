# Kubernetes Deployment for Artifactory MCP Server

This directory contains Kubernetes manifests for deploying the Artifactory MCP Server to GKE or any Kubernetes cluster.

## 📋 Prerequisites

- Kubernetes cluster (GKE, EKS, AKS, or any K8s cluster)
- `kubectl` configured to access your cluster
- Docker image pushed to a container registry accessible by your cluster
- Artifactory API credentials

## 🚀 Deployment Steps

### 1. Build and Push Docker Image

```bash
# Build the image
docker build -t your-registry/artifactory-mcp-server:v1.0.0 .

# Push to your registry
docker push your-registry/artifactory-mcp-server:v1.0.0
```

### 2. Create Namespace

```bash
kubectl apply -f namespace.yaml
```

### 3. Create Secret with Artifactory Credentials

**Option A: Using kubectl (Recommended for security)**

```bash
kubectl create secret generic artifactory-credentials \
  --from-literal=ARTIFACTORY_BASE_URL='https://your-instance.jfrog.io/artifactory' \
  --from-literal=ARTIFACTORY_ACCESS_TOKEN='your-access-or-identity-token' \
  --namespace=artifactory-mcp-server
```

**Option B: Using YAML file (Less secure)**

Edit `secret.yaml` with your credentials, then:

```bash
kubectl apply -f secret.yaml
```

**⚠️ Important:** Never commit `secret.yaml` with real credentials to git!

### 4. Update Deployment Image

Edit `deployment.yaml` and replace the image:

```yaml
image: your-registry/artifactory-mcp-server:v1.0.0
```

### 5. Deploy the Application

```bash
# Deploy all resources
kubectl apply -f deployment.yaml
kubectl apply -f service.yaml

# Or deploy everything at once
kubectl apply -f .
```

### 6. Verify Deployment

```bash
# Check if pods are running
kubectl get pods -n artifactory-mcp-server

# Check service
kubectl get svc -n artifactory-mcp-server

# View logs
kubectl logs -f deployment/artifactory-mcp-server -n artifactory-mcp-server
```

## 🔍 Checking Status

```bash
# Pod status
kubectl describe pod -l app=artifactory-mcp-server -n artifactory-mcp-server

# Service details
kubectl describe svc artifactory-mcp-server -n artifactory-mcp-server

# Recent events
kubectl get events -n artifactory-mcp-server --sort-by='.lastTimestamp'
```

## 🧪 Testing the MCP Server

### Port Forward to Test Locally

```bash
kubectl port-forward svc/artifactory-mcp-server 8080:80 -n artifactory-mcp-server
```

Then connect MCP Inspector to `http://localhost:8080/mcp`

### From Within the Cluster

The service is accessible at:
- `artifactory-mcp-server.artifactory-mcp-server.svc.cluster.local:80`
- Or simply: `artifactory-mcp-server:80` from within the same namespace

## 📊 Resource Configuration

Current resource limits:
- **CPU**: 1 core (limit), 500m (request)
- **Memory**: 1Gi (limit), 512Mi (request)

Adjust these in `deployment.yaml` based on your needs.

## 🔄 Updating the Deployment

```bash
# Update the image
kubectl set image deployment/artifactory-mcp-server \
  artifactory-mcp-server=your-registry/artifactory-mcp-server:v1.1.0 \
  -n artifactory-mcp-server

# Or edit deployment directly
kubectl edit deployment artifactory-mcp-server -n artifactory-mcp-server

# Rollout status
kubectl rollout status deployment/artifactory-mcp-server -n artifactory-mcp-server

# Rollback if needed
kubectl rollout undo deployment/artifactory-mcp-server -n artifactory-mcp-server
```

## 🗑️ Cleanup

```bash
# Delete all resources
kubectl delete -f .

# Or delete the entire namespace
kubectl delete namespace artifactory-mcp-server
```

## 🔒 Security Best Practices

1. **Never commit secrets to git** - Use Kubernetes secrets or external secret managers
2. **Use RBAC** - Limit access to the namespace
3. **Network Policies** - Restrict traffic to/from the MCP server
4. **Image Scanning** - Scan your Docker images for vulnerabilities
5. **Secret Rotation** - Regularly rotate your Artifactory API keys

## 📝 Additional Configuration

### Ingress (Optional)

If you need external access, create an Ingress resource:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: artifactory-mcp-server
  namespace: artifactory-mcp-server
spec:
  rules:
  - host: artifactory-mcp.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: artifactory-mcp-server
            port:
              number: 80
```

### Horizontal Pod Autoscaler (Optional)

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: artifactory-mcp-server
  namespace: artifactory-mcp-server
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: artifactory-mcp-server
  minReplicas: 1
  maxReplicas: 5
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## 🆘 Troubleshooting

### Pods not starting

```bash
kubectl describe pod -l app=artifactory-mcp-server -n artifactory-mcp-server
kubectl logs -l app=artifactory-mcp-server -n artifactory-mcp-server
```

### Secret issues

```bash
kubectl get secret artifactory-credentials -n artifactory-mcp-server
kubectl describe secret artifactory-credentials -n artifactory-mcp-server
```

### Connection issues

```bash
# Test from another pod in the cluster
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -n artifactory-mcp-server -- \
  curl -v http://artifactory-mcp-server/mcp
```



