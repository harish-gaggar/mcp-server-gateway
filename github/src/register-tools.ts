import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGithubClient } from "./github-client.js";
import { requireGithubToken } from "./request-context.js";

function client() {
  return createGithubClient(requireGithubToken());
}

export function registerGithubTools(server: McpServer): void {
  server.registerTool(
    "list_repositories",
    {
      description: "List repositories for the authenticated user or an organization",
      inputSchema: {
        owner: z.string().optional().describe("Organization or user (defaults to authenticated user)"),
        type: z.enum(["all", "owner", "public", "private", "member"]).optional(),
        sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(),
      },
    },
    async ({ owner, type, sort }) => {
      const gh = client();
      let endpoint = "/user/repos";
      const params: Record<string, string> = {};
      if (owner) endpoint = `/orgs/${owner}/repos`;
      if (type) params.type = type;
      if (sort) params.sort = sort;
      const { data } = await gh.get(endpoint, { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_repository_info",
    {
      description: "Get detailed information about a specific repository",
      inputSchema: {
        owner: z.string().describe("Repository owner"),
        repo: z.string().describe("Repository name"),
      },
    },
    async ({ owner, repo }) => {
      const { data } = await client().get(`/repos/${owner}/${repo}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_branches",
    {
      description: "List branches in a repository",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
      },
    },
    async ({ owner, repo }) => {
      const { data } = await client().get(`/repos/${owner}/${repo}/branches`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_issues",
    {
      description: "List issues in a repository",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).optional(),
        labels: z.string().optional(),
      },
    },
    async ({ owner, repo, state, labels }) => {
      const params: Record<string, string> = {};
      if (state) params.state = state;
      if (labels) params.labels = labels;
      const { data } = await client().get(`/repos/${owner}/${repo}/issues`, { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_issue",
    {
      description: "Get details about a specific issue",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number(),
      },
    },
    async ({ owner, repo, issue_number }) => {
      const { data } = await client().get(`/repos/${owner}/${repo}/issues/${issue_number}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "create_issue",
    {
      description: "Create a new issue in a repository",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignees: z.array(z.string()).optional(),
      },
    },
    async ({ owner, repo, title, body, labels, assignees }) => {
      const payload: Record<string, unknown> = { title };
      if (body) payload.body = body;
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;
      const { data } = await client().post(`/repos/${owner}/${repo}/issues`, payload);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_pull_requests",
    {
      description: "List pull requests in a repository",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        state: z.enum(["open", "closed", "all"]).optional(),
      },
    },
    async ({ owner, repo, state }) => {
      const params: Record<string, string> = {};
      if (state) params.state = state;
      const { data } = await client().get(`/repos/${owner}/${repo}/pulls`, { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_pull_request",
    {
      description: "Get details about a specific pull request",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        pull_number: z.number(),
      },
    },
    async ({ owner, repo, pull_number }) => {
      const { data } = await client().get(`/repos/${owner}/${repo}/pulls/${pull_number}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "search_code",
    {
      description: "Search for code in repositories",
      inputSchema: {
        query: z.string(),
        sort: z.enum(["indexed"]).optional(),
        order: z.enum(["desc", "asc"]).optional(),
      },
    },
    async ({ query, sort, order }) => {
      const params: Record<string, string> = { q: query };
      if (sort) params.sort = sort;
      if (order) params.order = order;
      const { data } = await client().get("/search/code", { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "search_repositories",
    {
      description: "Search for repositories",
      inputSchema: {
        query: z.string(),
        sort: z.enum(["stars", "forks", "updated"]).optional(),
        order: z.enum(["desc", "asc"]).optional(),
      },
    },
    async ({ query, sort, order }) => {
      const params: Record<string, string> = { q: query };
      if (sort) params.sort = sort;
      if (order) params.order = order;
      const { data } = await client().get("/search/repositories", { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_user_info",
    {
      description: "Get information about a GitHub user",
      inputSchema: {
        username: z.string(),
      },
    },
    async ({ username }) => {
      const { data } = await client().get(`/users/${username}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "list_commits",
    {
      description: "List commits in a repository",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        sha: z.string().optional(),
        per_page: z.number().optional(),
      },
    },
    async ({ owner, repo, sha, per_page }) => {
      const params: Record<string, string | number> = {};
      if (sha) params.sha = sha;
      if (per_page) params.per_page = per_page;
      const { data } = await client().get(`/repos/${owner}/${repo}/commits`, { params });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    "get_commit",
    {
      description: "Get details about a specific commit",
      inputSchema: {
        owner: z.string(),
        repo: z.string(),
        ref: z.string(),
      },
    },
    async ({ owner, repo, ref }) => {
      const { data } = await client().get(`/repos/${owner}/${repo}/commits/${ref}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );
}
