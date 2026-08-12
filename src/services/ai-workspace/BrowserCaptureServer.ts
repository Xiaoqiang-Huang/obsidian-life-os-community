import type { AiWorkspaceImportOptions, AiWorkspaceImportResult } from "./types";

type NodeRequireLike = (id: string) => unknown;

interface BrowserCaptureProject {
  id: string;
  name: string;
}

export interface BrowserCaptureRequest {
  projectId: string;
  conversation: unknown;
  options?: Partial<AiWorkspaceImportOptions>;
}

export interface BrowserCaptureServerConfig {
  port: number;
  token: string;
  listProjects: () => Promise<BrowserCaptureProject[]>;
  createProject: (input: { name: string; goal?: string }) => Promise<BrowserCaptureProject>;
  capture: (
    request: BrowserCaptureRequest,
    options: AiWorkspaceImportOptions
  ) => Promise<AiWorkspaceImportResult & { inboxPath?: string }>;
}

export interface BrowserCaptureServerStatus {
  available: boolean;
  running: boolean;
  port: number;
  endpoint: string;
  message: string;
}

interface RequestLike extends AsyncIterable<Uint8Array> {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  destroy(): void;
}

interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(value?: string): void;
}

interface ServerLike {
  listen(port: number, host: string, callback: () => void): void;
  close(callback?: (error?: Error) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
}

interface HttpModuleLike {
  createServer(listener: (request: RequestLike, response: ResponseLike) => void): ServerLike;
}

const MAX_REQUEST_BYTES = 18 * 1024 * 1024;

export class AiWorkspaceBrowserCaptureServer {
  private server: ServerLike | null = null;
  private config: BrowserCaptureServerConfig | null = null;
  private captureQueue: Promise<void> = Promise.resolve();
  private status: BrowserCaptureServerStatus = {
    available: false,
    running: false,
    port: 0,
    endpoint: "",
    message: "当前环境不支持本地浏览器桥。"
  };

  getStatus(): BrowserCaptureServerStatus {
    return { ...this.status };
  }

  async start(config: BrowserCaptureServerConfig): Promise<BrowserCaptureServerStatus> {
    await this.stop();
    const nodeRequire = this.nodeRequire();
    const port = this.normalizePort(config.port);
    const endpoint = `http://127.0.0.1:${port}`;
    if (!nodeRequire) {
      this.status = {
        available: false,
        running: false,
        port,
        endpoint,
        message: "移动端或受限环境不能启动本地浏览器桥，请使用扩展下载 JSON 后手动导入。"
      };
      return this.getStatus();
    }
    if (config.token.trim().length < 24) {
      this.status = {
        available: true,
        running: false,
        port,
        endpoint,
        message: "本地浏览器桥令牌无效，请在设置中重新生成。"
      };
      return this.getStatus();
    }
    const http = nodeRequire("http") as HttpModuleLike;
    this.config = { ...config, port, token: config.token.trim() };
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      this.status = {
        available: true,
        running: true,
        port,
        endpoint,
        message: `浏览器桥正在 ${endpoint} 监听，仅允许本机令牌请求。`
      };
    } catch (error) {
      this.server = null;
      this.config = null;
      this.status = {
        available: true,
        running: false,
        port,
        endpoint,
        message: error instanceof Error
          ? `浏览器桥启动失败：${error.message}`
          : "浏览器桥启动失败。"
      };
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.config = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    this.status = {
      ...this.status,
      running: false,
      message: "本地浏览器桥已停止。"
    };
  }

  private async handleRequest(request: RequestLike, response: ResponseLike): Promise<void> {
    const origin = this.header(request, "origin");
    if (!this.allowOrigin(origin)) {
      this.sendJson(response, 403, { ok: false, error: "不允许的浏览器扩展来源。" });
      return;
    }
    this.applyCors(
      response,
      origin,
      this.header(request, "access-control-request-private-network").toLowerCase() === "true"
    );
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${this.status.port || 27183}`);
    if (request.method === "GET" && requestUrl.pathname === "/v1/status") {
      this.sendJson(response, 200, {
        ok: true,
        service: "lifeos-web-ai-capture",
        version: 1,
        pairingRequired: true
      });
      return;
    }
    const config = this.config;
    if (!config || !this.status.running) {
      this.sendJson(response, 503, { ok: false, error: "Life OS 浏览器桥尚未启动。" });
      return;
    }
    if (!this.authorized(request, config.token)) {
      this.sendJson(response, 401, { ok: false, error: "连接令牌无效。" });
      return;
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${config.port}`);
    try {
      if (request.method === "GET" && url.pathname === "/v1/projects") {
        const projects = await config.listProjects();
        this.sendJson(response, 200, {
          ok: true,
          projects: projects.map((project) => ({
            id: String(project.id),
            name: String(project.name)
          }))
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/projects") {
        const body = this.asRecord(JSON.parse(await this.readBody(request)));
        const name = String(body.name || "").trim();
        const goal = String(body.goal || "").trim();
        if (!name) throw new Error("项目名称不能为空。");
        if (name.length > 100) throw new Error("项目名称不能超过 100 个字符。");
        const project = await config.createProject({ name, goal: goal || undefined });
        this.sendJson(response, 200, { ok: true, project });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        const body = this.asRecord(JSON.parse(await this.readBody(request)));
        const projectId = String(body.projectId || "").trim();
        if (!projectId) throw new Error("请选择要保存到的 Life OS 项目。");
        const options = this.normalizeOptions(body.options);
        const captureRequest: BrowserCaptureRequest = {
          projectId,
          conversation: body.conversation,
          options
        };
        const run = this.captureQueue.then(() => config.capture(captureRequest, options));
        this.captureQueue = run.then(() => undefined, () => undefined);
        const result = await run;
        this.sendJson(response, 200, {
          ok: true,
          status: result.status,
          sessionId: result.session.id,
          revisionId: result.revisionId,
          title: result.session.title,
          messageCount: result.session.messageCount,
          inboxPath: result.inboxPath || ""
        });
        return;
      }
      this.sendJson(response, 404, { ok: false, error: "未知的 Life OS 浏览器桥接口。" });
    } catch (error) {
      this.sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "网页会话保存失败。"
      });
    }
  }

  private normalizeOptions(value: unknown): AiWorkspaceImportOptions {
    const input = this.asRecord(value);
    return {
      includeToolCalls: input.includeToolCalls === true,
      includeFileReferences: input.includeFileReferences !== false,
      includeProjectMemory: input.includeProjectMemory !== false,
      includeToolMemory: input.includeToolMemory === true,
      retainRawSnapshot: input.retainRawSnapshot !== false,
      redactSecrets: input.redactSecrets !== false
    };
  }

  private async readBody(request: RequestLike): Promise<string> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        request.destroy();
        throw new Error("网页会话请求超过 18 MB 限制。");
      }
      chunks.push(chunk);
    }
    if (total === 0) throw new Error("请求正文为空。");
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  private authorized(request: RequestLike, token: string): boolean {
    const authorization = this.header(request, "authorization");
    if (authorization === `Bearer ${token}`) return true;
    return this.header(request, "x-lifeos-token") === token;
  }

  private allowOrigin(origin: string): boolean {
    if (!origin) return true;
    return /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+\/?$/i.test(origin);
  }

  private applyCors(response: ResponseLike, origin: string, privateNetworkRequested: boolean): void {
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-LifeOS-Token");
    if (privateNetworkRequested) response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Access-Control-Max-Age", "600");
    response.setHeader("Vary", "Origin, Access-Control-Request-Private-Network");
    response.setHeader("Cache-Control", "no-store");
  }

  private sendJson(response: ResponseLike, status: number, payload: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(payload));
  }

  private header(request: RequestLike, name: string): string {
    const value = request.headers[name] ?? request.headers[name.toLowerCase()];
    return Array.isArray(value) ? String(value[0] || "") : String(value || "");
  }

  private normalizePort(value: number): number {
    const port = Math.floor(Number(value));
    return Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : 27183;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private nodeRequire(): NodeRequireLike | null {
    const candidate = (globalThis as typeof globalThis & { require?: NodeRequireLike }).require;
    return typeof candidate === "function" ? candidate : null;
  }
}
