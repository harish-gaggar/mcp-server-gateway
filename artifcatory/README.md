# JFrog Artifactory MCP Server

A Model Context Protocol (MCP) server for JFrog Artifactory, built with Python and FastMCP.

## 🚀 Quick Start

### Prerequisites
- Docker and Docker Compose
- A JFrog Artifactory instance URL and an access/identity token

> **Auth note:** JFrog API keys are End-of-Life (new instances can't create
> them). Use an **access token** or **identity token** as a Bearer credential
> via `ARTIFACTORY_ACCESS_TOKEN`. The legacy `ARTIFACTORY_API_KEY` is still
> honored as a fallback for older self-hosted instances.

### Running with Docker (Recommended)

1. **Set your Artifactory credentials in `docker-compose.yml`:**
   ```yaml
   environment:
     - ARTIFACTORY_BASE_URL=https://your-instance.jfrog.io/artifactory
     - ARTIFACTORY_ACCESS_TOKEN=your-access-or-identity-token
   ```

2. **Start the server:**
   ```bash
   docker compose up -d --build
   ```

3. **Test with MCP Inspector:**
   - Install MCP Inspector: `npm install -g @modelcontextprotocol/inspector`
   - Run: `npx @modelcontextprotocol/inspector`
   - Open: http://localhost:6274
   - Connect using:
     - Transport Type: **Streamable HTTP**
     - URL: **http://localhost:8080/mcp**

4. **View logs:**
   ```bash
   docker logs artifactory-mcp-server
   ```

5. **Stop the server:**
   ```bash
   docker compose down
   ```

### Running Locally (without Docker)

1. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **Set environment variables:**
   ```bash
   export ARTIFACTORY_BASE_URL="https://your-instance.jfrog.io/artifactory"
   export ARTIFACTORY_ACCESS_TOKEN="your-access-or-identity-token"
   export HOST="0.0.0.0"
   export PORT="8080"
   ```

3. **Run the server:**
   ```bash
   python server.py
   ```

## 🛠️ Available Tools

The MCP server provides the following tools:

- **`list_repositories`** - List all repositories (with optional type filter)
- **`get_repository_info`** - Get detailed repository information
- **`search_artifacts`** - Search for artifacts using AQL
- **`get_artifact_info`** - Get information about a specific artifact
- **`get_folder_info`** - Get folder contents and structure
- **`get_system_info`** - Get Artifactory system version
- **`get_storage_info`** - Get storage summary information

## 📝 Configuration

Configure the server using environment variables:

- `ARTIFACTORY_BASE_URL` - Your Artifactory instance URL (required)
- `ARTIFACTORY_ACCESS_TOKEN` - JFrog access/identity token, sent as `Authorization: Bearer` (recommended)
- `ARTIFACTORY_API_KEY` - Legacy API key fallback, sent as `X-JFrog-Art-Api` (optional, deprecated)
- `HOST` - Server bind address (default: `0.0.0.0`)
- `PORT` - Server port (default: `8080`)

## 🐳 Docker Deployment

For production deployment (e.g., GKE), the server runs with Streamable HTTP transport, making it accessible over HTTP/HTTPS.

### Building the Docker Image

```bash
docker build -t artifactory-mcp-server .
```

### Running the Container

```bash
docker run -d \
  -p 8080:8080 \
  -e ARTIFACTORY_BASE_URL="https://your-instance.jfrog.io/artifactory" \
  -e ARTIFACTORY_ACCESS_TOKEN="your-access-or-identity-token" \
  --name artifactory-mcp-server \
  artifactory-mcp-server
```

## ☸️ Kubernetes Deployment (GKE/K8s)

For production deployment to Kubernetes (GKE, EKS, AKS, etc.), see the [k8s/](k8s/) directory for:

- Namespace configuration
- Kubernetes Secret for credentials
- Deployment manifest
- Service definition
- Detailed deployment instructions

**Quick deployment:**

```bash
# 1. Create namespace
kubectl apply -f k8s/namespace.yaml

# 2. Create secret with your credentials
kubectl create secret generic artifactory-credentials \
  --from-literal=ARTIFACTORY_BASE_URL='https://your-instance.jfrog.io/artifactory' \
  --from-literal=ARTIFACTORY_ACCESS_TOKEN='your-access-or-identity-token' \
  --namespace=artifactory-mcp-server

# 3. Deploy (update image in deployment.yaml first)
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

See [k8s/README.md](k8s/README.md) for complete instructions.

### Production Deployment with Flux CD and CI/CD

For production deployments using GitOps with Flux CD:

**📚 Step-by-Step Setup Guide:** [FLUX_SETUP_GUIDE.md](FLUX_SETUP_GUIDE.md) ⭐  
**🔄 Visual Flow Diagram:** [FLUX_FLOW_DIAGRAM.md](FLUX_FLOW_DIAGRAM.md)  
**📖 Detailed Documentation:** [k8s/README.md](k8s/README.md)

**Quick Overview:**
1. **CI/CD** builds and pushes Docker images to **Google Artifact Registry**
2. **CI/CD** updates `kustomization.yaml` with new image tag
3. **Flux CD** detects Git changes and automatically deploys to GKE
4. **Secrets** managed via Google Secret Manager with External Secrets Operator

**The Flow: PR Merge → Production in ~3 minutes**
```
PR Merged → GitHub Actions → Build Image → Push to GAR
→ Update Manifests → Git Push → Flux Detects → Deploy to GKE ✅
```

**Supported CI/CD Platforms:**
- ✅ **GitHub Actions** - Full example in `.github/workflows/build-and-deploy.yml`
- ✅ **GitLab CI** - Configuration example in [FLUX_SETUP_GUIDE.md](FLUX_SETUP_GUIDE.md)
- ✅ **CircleCI** - Full config in `.circleci/config.yml` + [setup guide](.circleci/README.md)

**Key Features:**
- ✅ Automated image builds and push to Google Artifact Registry
- ✅ GitOps workflow with Flux CD (Git as source of truth)
- ✅ Secure secret management with GCP Secret Manager
- ✅ Multi-environment support (staging/production)
- ✅ Automated rollouts and health checks
- ✅ Easy rollback procedures (just revert Git commit)
- ✅ Complete automation: merge PR → deployed in ~3 minutes

**Getting Started:**
```bash
# Follow the step-by-step guide
open FLUX_SETUP_GUIDE.md

# Or quick view the complete flow
open FLUX_FLOW_DIAGRAM.md
```

## 🔧 Development

### Project Structure

```
.
├── server.py                      # Main MCP server implementation
├── requirements.txt               # Python dependencies
├── Dockerfile                     # Docker image definition
├── docker-compose.yml             # Docker Compose configuration
├── README.md                      # This file
├── FLUX_SETUP_GUIDE.md           # ⭐ Step-by-step Flux CD setup
├── FLUX_FLOW_DIAGRAM.md          # Visual deployment flow
├── .github/
│   └── workflows/
│       └── build-and-deploy.yml  # GitHub Actions CI/CD pipeline
├── .circleci/
│   ├── config.yml                # CircleCI pipeline configuration
│   └── README.md                 # CircleCI setup guide
└── k8s/                          # Kubernetes manifests
    ├── namespace.yaml            # Namespace definition
    ├── secret.yaml               # External Secrets template
    ├── deployment.yaml           # Deployment manifest
    ├── service.yaml              # Service definition
    ├── kustomization.yaml        # Kustomize config
    ├── README.md                 # K8s deployment guide
    └── QUICK_REFERENCE.md        # Quick command reference
```

### Dependencies

- `mcp[server]>=1.0.0` - Model Context Protocol SDK with FastMCP
- `httpx>=0.27.0` - HTTP client for Artifactory API

## 📚 Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [JFrog Artifactory REST API](https://jfrog.com/help/r/jfrog-rest-apis/artifactory-rest-api)
- [FastMCP Documentation](https://github.com/modelcontextprotocol/python-sdk)

## 📄 License

This project is provided as-is for educational and demonstration purposes.
