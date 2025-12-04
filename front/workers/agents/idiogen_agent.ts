import {
  Agent,
  AgentNamespace,
  Connection,
  ConnectionContext,
  WSMessage,
} from "agents";

interface WorkersAI {
  run(model: string, input: Record<string, unknown>): Promise<object>;
}

interface Env {
  AI: WorkersAI;
}

interface State {
  flex: string;
  bison: string;
}

export class IdioGenAgent extends Agent<Env, State> {
  async onStart(props?: Record<string, unknown> | undefined) {
    console.log("Agent started. AI exists?", !!this.env.AI);
    console.log("Agent started with state:", this.state);
    console.log("props:", props);
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return new Response("This agent only responds to post requests.");
    const body = await request.json();
    if (!("prompt" in body))
      return new Response(
        "Post request body needs a prompt key with the prompt as the value.",
      );

    const prompt = `
    Generate a fully fledged language specification using bison + flex and also create an interpretter that uses the parser generated with the bison and flex files in c for a language of this spec:
    ${body.prompt}

    Format your response like this and don't add any text deviating from this format:
    {
    	"flex": <the flex file you generated>,
     	"bison": <the bison file you generated>,
      	"interpretter": <the interpretter you created>
    }
    `;
    const result = this.env.AI.run("@cf/meta/llama-3.3-70b-instruct", {
      messages: [{ role: "user", content: prompt }],
    });
    return Response.json(result);
  }

  async onMessage(connection: Connection, message: WSMessage) {
    connection.send("Recieved your message of :" + message.toString());
  }

  async onError(connection: unknown, error?: unknown) {
    console.error(`Connection error:`, error);
  }

  async onClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    console.log(
      `Connection closed${wasClean ? " cleanly" : ""}: ${code} - ${reason}`,
    );
  }

  onStateUpdate(state: State | undefined, source: Connection | "server"): void {
    console.log("State updated:", state, "Source:", source);
  }
}
