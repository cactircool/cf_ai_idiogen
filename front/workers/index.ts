import { routeAgentRequest } from "agents";

const mod = {
  async fetch(request: Request, env: object) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("not found", { status: 404 })
    );
  },
};

export default mod;
