import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

const TASKS_API = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/tasks`;

interface Task {
  id: string;
  title: string;
  done: boolean;
}

// 所有对任务 API 的调用都从这里走，统一处理错误。
async function callTasksApi(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${TASKS_API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : `HTTP ${response.status}`);
  }
  return data;
}

async function listTasks(): Promise<Task[]> {
  return (await callTasksApi("GET", "")) as Task[];
}

function toModelMessages(messages: ChatMessage[]) {
  return messages.map((message) =>
    message.role === "user"
      ? { role: "user" as const, content: message.content }
      : { role: "assistant" as const, content: message.content },
  );
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "addTask",
      description: "新增一条待办任务。用户说'记一下''提醒我''别忘了'时使用。",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "任务标题，只保留任务本身，比如'买牛奶'，不要带'帮我记一下'。",
          },
        },
        required: ["title"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "completeTask",
      description: "把一条已有任务标记为已完成。用户说'做完了''搞定了''买好了'时使用。",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "目标任务的 id，必须从当前清单里原样复制，不要自己编。",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "deleteTask",
      description: "删除一条任务。用户说'删掉''去掉''不用了'时使用。",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "目标任务的 id，必须从当前清单里原样复制，不要自己编。",
          },
        },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `你是"小明"，一个中文待办清单助手。
每次对话我都会告诉你用户当前的清单，你要据此回答。

规则：
- 清单非空时按顺序列出，每条前面用 ⬜ 表示待办、✅ 表示已完成。
- 清单为空时，直接说"你现在没有待办"。
- 只根据清单回答，绝不编造清单里没有的任务。
- 创建、完成、删除任务时必须调用对应的工具，不要只在嘴上答应。
- 用简短的中文口语回答，不要输出 JSON、表格或 Markdown。`;

// 执行模型申请的单个工具调用，把结果说成一句给模型看的话。
async function executeToolCall(call: {
  id: string;
  function: { name: string; arguments: string };
}): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(call.function.arguments) as Record<string, string>;
  } catch {
    return "参数解析失败：工具参数不是合法 JSON。";
  }

  try {
    switch (call.function.name) {
      case "addTask": {
        const task = await callTasksApi("POST", "", { title: args.title });
        return `已创建任务「${task.title}」，当前未完成，id=${task.id}`;
      }
      case "completeTask": {
        const task = await callTasksApi("PATCH", `/${args.taskId}`, { done: true });
        return `任务「${task.title}」已标记为已完成。`;
      }
      case "deleteTask": {
        await callTasksApi("DELETE", `/${args.taskId}`);
        return "任务已删除。";
      }
      default:
        return `没有这个工具：${call.function.name}`;
    }
  } catch (error) {
    return `执行失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function reply(messages: ChatMessage[]): Promise<string> {
  const tasks = await listTasks();

  const listing =
    tasks.length === 0
      ? "（当前没有任何任务）"
      : tasks
          .map(
            (task, index) =>
              `${index + 1}. ${task.done ? "✅" : "⬜"} ${task.title}（id: ${task.id}）`,
          )
          .join("\n");

  const client = getModelClient();
  const conversation = [
    { role: "system" as const, content: `${SYSTEM_PROMPT}\n\n当前清单：\n${listing}` },
    ...toModelMessages(messages),
  ];

  // 第一轮：把清单和用户的话交给模型，看它想做什么。
  const first = await client.chat.completions.create({
    model,
    messages: conversation,
    tools: TOOLS,
    tool_choice: "auto",
  });

  const plan = first.choices[0]?.message;

  // 它不想动手，只是说话。
  if (!plan?.tool_calls?.length) {
    return plan?.content?.trim() || "抱歉，我没听明白。";
  }

  // 它想动手：逐个执行，把结果收集成 tool 消息。
  const results: { role: "tool"; tool_call_id: string; content: string }[] = [];
  for (const call of plan.tool_calls) {
    const content = await executeToolCall(call);
    results.push({ role: "tool", tool_call_id: call.id, content });
  }

  // 第二轮：把执行结果交回去，让它组织一句人话。
  const second = await client.chat.completions.create({
    model,
    messages: [...conversation, plan, ...results],
    tools: TOOLS,
    tool_choice: "auto",
  });

  return second.choices[0]?.message?.content?.trim() || "已经处理好了。";
}