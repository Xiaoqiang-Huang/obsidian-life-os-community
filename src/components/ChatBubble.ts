import type { App, Component } from "obsidian";
import type { ChatMessage } from "../types";
import { createMarkdownDisplay } from "../utils/markdown-render";

export function createChatBubble(parent: HTMLElement, app: App, component: Component, message: ChatMessage): HTMLElement {
  const bubble = parent.createDiv({
    cls: message.role === "user" ? "lifeos-chat-bubble-user" : "lifeos-chat-bubble-ai"
  });
  bubble.createDiv({ cls: "lifeos-chat-bubble-label", text: message.role === "user" ? "我" : "Life OS" });
  createMarkdownDisplay(bubble, app, component, message.content, { cls: "lifeos-chat-bubble-content" });
  return bubble;
}
