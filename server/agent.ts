import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";

export type { ChatMessage } from "../shared/chat.ts";

const TASKS_API = `http://127.0.0.1:${process.env.PORT ?? 3000}/api/tasks`;

interface Task {
  id: string;
  title: string;
  done: boolean;
}

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

// 给模型看的清单：带汇总数字和 id，方便它指认要操作哪一条。
function formatListing(tasks: Task[]): string {
  if (tasks.length === 0) return "（当前没有任何任务）";

  const pending = tasks.filter((task) => !task.done).length;
  const lines = tasks
    .map((task, index) => `${index + 1}. ${task.done ? "✅" : "□"} ${task.title}（id: ${task.id}）`)
    .join("\n");

  return `共 ${tasks.length} 条，待办 ${pending} 条，已完成 ${tasks.length - pending} 条：\n${lines}`;
}

// 给用户看的清单：由代码渲染，按状态分组、保留原始序号、不显示 id。
function formatForUser(tasks: Task[]): string {
  if (tasks.length === 0) return "你现在没有待办。";

  const numbered = tasks.map((task, index) => ({ no: index + 1, task }));
  const pending = numbered.filter((item) => !item.task.done);
  const finished = numbered.filter((item) => item.task.done);

  const parts = [`共 ${tasks.length} 条，待办 ${pending.length} 条，已完成 ${finished.length} 条。`];

  if (pending.length > 0) {
    parts.push("", "待办：");
    for (const item of pending) parts.push(`${item.no}. □ ${item.task.title}`);
  }

  if (finished.length > 0) {
    parts.push("", "已完成：");
    for (const item of finished) parts.push(`${item.no}. ✅ ${item.task.title}`);
  }

  return parts.join("\n");
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "listTasks",
      description: "查看用户当前的待办清单。用户问'我有哪些任务''看看清单''还有什么没做'时调用。",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
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
每次对话我都会告诉你用户当前的清单（含汇总数字和每条的序号），你要据此回答。

规则：
- 用户想查看清单时，必须调用 listTasks 工具，不要在回复里自己列出任务。
- 只根据清单回答，绝不编造清单里没有的任务。
- 创建、完成、删除任务时必须调用对应的工具，不要只在嘴上答应。
- 用简短的中文口语回答，不要输出 JSON 或 Markdown 表格。`;

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
      case "listTasks": {
        return formatForUser(await listTasks());
      }
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
  const history = toModelMessages(messages);
  const client = getModelClient();

  // 第一轮：用当前清单做判断。
  const before = formatListing(await listTasks());
  const first = await client.chat.completions.create({
    model,
    messages: [
      { role: "system" as const, content: `${SYSTEM_PROMPT}\n\n当前清单：\n${before}` },
      ...history,
    ],
    tools: TOOLS,
    tool_choice: "auto",
  });

  const plan = first.choices[0]?.message;

  if (!plan?.tool_calls?.length) {
    return plan?.content?.trim() || "抱歉，我没听明白。";
  }

  console.log(
    "工具调用：",
    plan.tool_calls.map((c) => `${c.function.name}(${c.function.arguments})`).join(" | "),
  );

  const executed: { name: string; callId: string; content: string }[] = [];
  for (const call of plan.tool_calls) {
    executed.push({
      name: call.function.name,
      callId: call.id,
      content: await executeToolCall(call),
    });
  }

  // 用户只是想看清单：直接用代码渲染好的文本回复，不交给模型复述。
  const listing = executed.find((item) => item.name === "listTasks");
  if (listing) {
    const others = executed.filter((item) => item.name !== "listTasks").map((item) => item.content);
    return [...others, listing.content].join("\n\n");
  }

  // 第二轮：重新读一次清单，把最新的真实状态交给模型组织回复。
  const after = formatListing(await listTasks());
  const second = await client.chat.completions.create({
    model,
    messages: [
      { role: "system" as const, content: `${SYSTEM_PROMPT}\n\n当前清单（刚刚更新）：\n${after}` },
      ...history,
      plan,
      ...executed.map((item) => ({
        role: "tool" as const,
        tool_call_id: item.callId,
        content: item.content,
      })),
    ],
    tools: TOOLS,
    tool_choice: "none",
  });

  return second.choices[0]?.message?.content?.trim() || "已经处理好了。";
}