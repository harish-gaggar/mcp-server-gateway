import axios, { type AxiosInstance } from "axios";

/** Public GitHub REST API or GitHub Enterprise API base URL. */
export function githubApiBase(): string {
  const raw = process.env.GITHUB_API_URL?.replace(/\/$/, "");
  if (raw) return raw;
  const enterprise = process.env.GITHUB_ENTERPRISE_URL?.replace(/\/$/, "");
  if (enterprise) return `${enterprise}/api/v3`;
  return "https://api.github.com";
}

export function createGithubClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: githubApiBase(),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });
}

/** Validate token and return the authenticated user's login. */
export async function fetchAuthenticatedLogin(
  client: AxiosInstance
): Promise<string> {
  const { data } = await client.get<{ login?: string }>("/user");
  if (!data.login) {
    throw new Error("GitHub /user response missing login");
  }
  return data.login;
}
