#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

// Environment variables
const GITHUB_ENTERPRISE_URL = process.env.GITHUB_ENTERPRISE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_ENTERPRISE_URL || !GITHUB_TOKEN) {
  console.error("Error: GITHUB_ENTERPRISE_URL and GITHUB_TOKEN environment variables must be set");
  process.exit(1);
}

// Create axios instance for GitHub Enterprise API
const githubClient: AxiosInstance = axios.create({
  baseURL: `${GITHUB_ENTERPRISE_URL}/api/v3`,
  headers: {
    "Authorization": `token ${GITHUB_TOKEN}`,
    "Accept": "application/vnd.github.v3+json",
    "Content-Type": "application/json",
  },
});

// Function to create and configure a new server instance
export function createServer(): Server {
  const server = new Server(
    {
      name: "github-enterprise-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case "list_repositories": {
          const owner = args?.owner as string | undefined;
          const type = args?.type as string | undefined;
          const sort = args?.sort as string | undefined;
          
          let endpoint = "/user/repos";
          const params: any = {};
          
          if (owner) {
            endpoint = `/orgs/${owner}/repos`;
          }
          
          if (type) params.type = type;
          if (sort) params.sort = sort;
          
          const response = await githubClient.get(endpoint, { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "get_repository_info": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const response = await githubClient.get(`/repos/${owner}/${repo}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "list_branches": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const response = await githubClient.get(`/repos/${owner}/${repo}/branches`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "list_issues": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const state = args?.state as string | undefined;
          const labels = args?.labels as string | undefined;
          
          const params: any = {};
          if (state) params.state = state;
          if (labels) params.labels = labels;
          
          const response = await githubClient.get(`/repos/${owner}/${repo}/issues`, { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "get_issue": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const issue_number = args?.issue_number as number;
          const response = await githubClient.get(`/repos/${owner}/${repo}/issues/${issue_number}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "create_issue": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const title = args?.title as string;
          const body = args?.body as string | undefined;
          const labels = args?.labels as string[] | undefined;
          const assignees = args?.assignees as string[] | undefined;
          
          const data: any = { title };
          if (body) data.body = body;
          if (labels) data.labels = labels;
          if (assignees) data.assignees = assignees;
          
          const response = await githubClient.post(`/repos/${owner}/${repo}/issues`, data);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "list_pull_requests": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const state = args?.state as string | undefined;
          
          const params: any = {};
          if (state) params.state = state;
          
          const response = await githubClient.get(`/repos/${owner}/${repo}/pulls`, { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "get_pull_request": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const pull_number = args?.pull_number as number;
          const response = await githubClient.get(`/repos/${owner}/${repo}/pulls/${pull_number}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "search_code": {
          const query = args?.query as string;
          const sort = args?.sort as string | undefined;
          const order = args?.order as string | undefined;
          
          const params: any = { q: query };
          if (sort) params.sort = sort;
          if (order) params.order = order;
          
          const response = await githubClient.get("/search/code", { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "search_repositories": {
          const query = args?.query as string;
          const sort = args?.sort as string | undefined;
          const order = args?.order as string | undefined;
          
          const params: any = { q: query };
          if (sort) params.sort = sort;
          if (order) params.order = order;
          
          const response = await githubClient.get("/search/repositories", { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "get_user_info": {
          const username = args?.username as string;
          const response = await githubClient.get(`/users/${username}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "list_commits": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const sha = args?.sha as string | undefined;
          const per_page = args?.per_page as number | undefined;
          
          const params: any = {};
          if (sha) params.sha = sha;
          if (per_page) params.per_page = per_page;
          
          const response = await githubClient.get(`/repos/${owner}/${repo}/commits`, { params });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        case "get_commit": {
          const owner = args?.owner as string;
          const repo = args?.repo as string;
          const ref = args?.ref as string;
          const response = await githubClient.get(`/repos/${owner}/${repo}/commits/${ref}`);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(response.data, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      const errorMessage = error.response?.data?.message || error.message || "Unknown error";
      const statusCode = error.response?.status || "N/A";
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage} (Status: ${statusCode})`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

// Define tools
const tools: Tool[] = [
  {
    name: "list_repositories",
    description: "List repositories for a user or organization",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Organization or user name (optional, defaults to authenticated user's repos)",
        },
        type: {
          type: "string",
          description: "Type of repositories to list",
          enum: ["all", "owner", "public", "private", "member"],
        },
        sort: {
          type: "string",
          description: "Sort field",
          enum: ["created", "updated", "pushed", "full_name"],
        },
      },
    },
  },
  {
    name: "get_repository_info",
    description: "Get detailed information about a specific repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner (organization or user)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_branches",
    description: "List branches in a repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "list_issues",
    description: "List issues in a repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        state: {
          type: "string",
          description: "Issue state filter",
          enum: ["open", "closed", "all"],
        },
        labels: {
          type: "string",
          description: "Comma-separated list of label names",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_issue",
    description: "Get details about a specific issue",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        issue_number: {
          type: "number",
          description: "Issue number",
        },
      },
      required: ["owner", "repo", "issue_number"],
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue in a repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        title: {
          type: "string",
          description: "Issue title",
        },
        body: {
          type: "string",
          description: "Issue body/description",
        },
        labels: {
          type: "array",
          description: "Array of label names",
          items: {
            type: "string",
          },
        },
        assignees: {
          type: "array",
          description: "Array of usernames to assign",
          items: {
            type: "string",
          },
        },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    name: "list_pull_requests",
    description: "List pull requests in a repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        state: {
          type: "string",
          description: "Pull request state filter",
          enum: ["open", "closed", "all"],
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_pull_request",
    description: "Get details about a specific pull request",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        pull_number: {
          type: "number",
          description: "Pull request number",
        },
      },
      required: ["owner", "repo", "pull_number"],
    },
  },
  {
    name: "search_code",
    description: "Search for code in repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (supports GitHub search syntax)",
        },
        sort: {
          type: "string",
          description: "Sort field",
          enum: ["indexed"],
        },
        order: {
          type: "string",
          description: "Sort order",
          enum: ["desc", "asc"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "search_repositories",
    description: "Search for repositories",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (supports GitHub search syntax)",
        },
        sort: {
          type: "string",
          description: "Sort field",
          enum: ["stars", "forks", "updated"],
        },
        order: {
          type: "string",
          description: "Sort order",
          enum: ["desc", "asc"],
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_user_info",
    description: "Get information about a GitHub user",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "GitHub username",
        },
      },
      required: ["username"],
    },
  },
  {
    name: "list_commits",
    description: "List commits in a repository",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        sha: {
          type: "string",
          description: "SHA or branch to start listing commits from",
        },
        per_page: {
          type: "number",
          description: "Number of results per page (max 100)",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "get_commit",
    description: "Get details about a specific commit",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        ref: {
          type: "string",
          description: "Commit SHA or branch name",
        },
      },
      required: ["owner", "repo", "ref"],
    },
  },
];

// Main function - Start server with STDIO transport
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error("GitHub Enterprise MCP Server running on STDIO");
  console.error("Connected to:", GITHUB_ENTERPRISE_URL);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// OLD CODE TO REMOVE - placeholder to prevent errors
if (false) {
  const dummy = async (request: any) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
      case "list_repositories": {
        const owner = args?.owner as string | undefined;
        const type = args?.type as string | undefined;
        const sort = args?.sort as string | undefined;
        
        let endpoint = "/user/repos";
        const params: any = {};
        
        if (owner) {
          endpoint = `/orgs/${owner}/repos`;
        }
        
        if (type) params.type = type;
        if (sort) params.sort = sort;
        
        const response = await githubClient.get(endpoint, { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "get_repository_info": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const response = await githubClient.get(`/repos/${owner}/${repo}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "list_branches": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const response = await githubClient.get(`/repos/${owner}/${repo}/branches`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "list_issues": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const state = args?.state as string | undefined;
        const labels = args?.labels as string | undefined;
        
        const params: any = {};
        if (state) params.state = state;
        if (labels) params.labels = labels;
        
        const response = await githubClient.get(`/repos/${owner}/${repo}/issues`, { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "get_issue": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const issue_number = args?.issue_number as number;
        const response = await githubClient.get(`/repos/${owner}/${repo}/issues/${issue_number}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "create_issue": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const title = args?.title as string;
        const body = args?.body as string | undefined;
        const labels = args?.labels as string[] | undefined;
        const assignees = args?.assignees as string[] | undefined;
        
        const data: any = { title };
        if (body) data.body = body;
        if (labels) data.labels = labels;
        if (assignees) data.assignees = assignees;
        
        const response = await githubClient.post(`/repos/${owner}/${repo}/issues`, data);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "list_pull_requests": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const state = args?.state as string | undefined;
        
        const params: any = {};
        if (state) params.state = state;
        
        const response = await githubClient.get(`/repos/${owner}/${repo}/pulls`, { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "get_pull_request": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const pull_number = args?.pull_number as number;
        const response = await githubClient.get(`/repos/${owner}/${repo}/pulls/${pull_number}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "search_code": {
        const query = args?.query as string;
        const sort = args?.sort as string | undefined;
        const order = args?.order as string | undefined;
        
        const params: any = { q: query };
        if (sort) params.sort = sort;
        if (order) params.order = order;
        
        const response = await githubClient.get("/search/code", { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "search_repositories": {
        const query = args?.query as string;
        const sort = args?.sort as string | undefined;
        const order = args?.order as string | undefined;
        
        const params: any = { q: query };
        if (sort) params.sort = sort;
        if (order) params.order = order;
        
        const response = await githubClient.get("/search/repositories", { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "get_user_info": {
        const username = args?.username as string;
        const response = await githubClient.get(`/users/${username}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "list_commits": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const sha = args?.sha as string | undefined;
        const per_page = args?.per_page as number | undefined;
        
        const params: any = {};
        if (sha) params.sha = sha;
        if (per_page) params.per_page = per_page;
        
        const response = await githubClient.get(`/repos/${owner}/${repo}/commits`, { params });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      case "get_commit": {
        const owner = args?.owner as string;
        const repo = args?.repo as string;
        const ref = args?.ref as string;
        const response = await githubClient.get(`/repos/${owner}/${repo}/commits/${ref}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response.data, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return { content: [], isError: true };
  }
  };
}

