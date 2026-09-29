# Literature Review: Communication Architectures for an Agentic AI Harness

This review examines ten sources relevant to coordinating agents, sharing state, invoking tools, and communicating with a model server. The first five are research papers; the remaining five are specifications, official documentation, or a maintainer’s technical account. Each entry summarizes the source and then discusses its implications for a cyber research harness. Those implications are proposed applications of the literature, rather than experimentally established results for the West Point project. Living documentation was consulted on 16 September 2026.

## 1. Incalmo: An Autonomous LLM-assisted System for Red Teaming Multi-Host Networks

**Authors:** Brian Singer, Keane Lucas, Lakshmi Adiga, Meghna Jain, Lujo Bauer, and Vyas Sekar. **Year:** 2025; version 4.

Singer and colleagues investigate why LLM-based systems struggle with red-team exercises spanning multiple hosts. Incalmo separates high-level planning from execution: an LLM selects declarative tasks, and specialized non-LLM agents implement them. Supporting services maintain environment knowledge, possible attack paths, and execution access. This architecture reduces the planner’s need to retain low-level operational details. The evaluation concerns emulated networks with known vulnerabilities and does not model active defender interference, limiting its generalizability. [Source](https://arxiv.org/html/2501.16466v4)

For the proposed harness, Incalmo suggests a clear contract between planners and workers. A task message should identify the objective, relevant assets, and required inputs; a result should communicate status and supporting observations. Shared knowledge should be queryable instead of copied into every conversation. This separation would allow a worker implementation to change without changing the planner’s interface. It also makes failure attribution clearer: an unsuitable plan, a failed executor, and an incorrect state update are distinct problems.

## 2. PentestGPT: Evaluating and Harnessing Large Language Models for Automated Penetration Testing

**Authors:** Gelei Deng, Yi Liu, Víctor Mayoral-Vilches, Peng Liu, Yuekang Li, Yuan Xu, Tianwei Zhang, Yang Liu, Martin Pinzger, and Stefan Rass. **Year:** 2024; USENIX Security.

PentestGPT addresses the difficulty of maintaining an overall testing strategy while processing detailed operational information. Its reasoning module manages high-level decisions, its generation module develops specific procedures, and its parsing module condenses external output. A Pentesting Task Tree records progress and guides subsequent work. This division makes context management a central architectural concern. The published system is interactive, so its results should not be treated as evidence of fully unattended operation. [Source](https://arxiv.org/html/2308.06782v2)

For the communication layer, the implication is that message preparation can be as consequential as message delivery. A parser may remove irrelevant output, but it may also discard information needed later. The harness should therefore preserve original artifacts alongside summaries and link each reported observation to its source. Task status should persist independently of an individual model conversation. This would let a replacement worker recover the current assignment without reconstructing the entire history from unstructured dialogue.

## 3. AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation

**Authors:** Qingyun Wu, Gagan Bansal, Jieyu Zhang, Yiran Wu, Beibin Li, Erkang Zhu, Li Jiang, Xiaoyun Zhang, Shaokun Zhang, Jiale Liu, Ahmed Hassan Awadallah, Ryen W. White, Doug Burger, and Chi Wang. **Year:** 2023.

AutoGen organizes workflows around agents that send, receive, and respond to messages. Agents may incorporate LLMs, tools, or human input. Its conversation-programming approach combines natural-language instructions with programmed control rules, enabling fixed exchanges and dynamic interactions. The paper demonstrates applications across several domains, but does not establish one universally superior communication topology. Its publication-era architecture should also be distinguished from later software interfaces. [Source](https://arxiv.org/html/2308.08155v2)

For this project, AutoGen offers a baseline in which conversation determines workflow progression. The harness must establish recipient selection, reply handling, and termination rules. Automatically responding to every message could create repeated exchanges without useful progress. Explicit turn limits, task ownership, and typed completion signals would make these interactions easier to control. This design could be compared experimentally with a coordinator that assigns bounded tasks and receives structured results.

## 4. MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework

**Authors:** Sirui Hong, Mingchen Zhuge, Jiaqi Chen, Xiawu Zheng, Yuheng Cheng, Ceyao Zhang, Jinlin Wang, Zili Wang, Steven Ka Shing Yau, Zijuan Lin, Liyang Zhou, Chenyu Ran, Lingfeng Xiao, Chenglin Wu, and Jürgen Schmidhuber. **Year:** 2023; revised 2024.

MetaGPT organizes collaboration through specialized roles and standard operating procedures. Agents produce structured outputs, publish them to a shared message pool, and subscribe to information relevant to their responsibilities. This mechanism makes intermediate deliverables and dependencies explicit. Evaluations concern collaborative software engineering, so transferring the architecture to cyber tasks requires additional testing. [Source](https://arxiv.org/html/2308.00352)

The technical implication is that communication can center on typed information products. A worker could publish a service observation, verification result, or task failure, with subscribers receiving relevant categories. The harness could validate required fields and release dependent tasks when their inputs become available. Applying this approach would also require versioning and conflict rules for updates to the same asset. A correctly formatted message would still need evidence checks before its contents became accepted facts.

## 5. ReAct: Synergizing Reasoning and Acting in Language Models

**Authors:** Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan, and Yuan Cao. **Year:** 2023; ICLR, following a 2022 preprint.

ReAct interleaves model reasoning with actions and observations from an external environment. The model can revise its approach using information obtained through interaction, rather than relying entirely on its initial knowledge. The authors evaluate question answering, fact verification, and interactive decision-making tasks. ReAct establishes a useful individual-agent loop, but does not define a multi-agent network protocol or distributed task lifecycle. [Source](https://arxiv.org/html/2210.03629v3)

For a harness, ReAct highlights the need to distinguish an action request from the observation produced by its execution. Each tool result should be associated with the request that caused it, and execution errors should return through an explicit error path. In a multi-agent setting, this helps prevent one worker from interpreting another worker’s output as its own result. The harness should record the observable sequence of requests, executions, and results; exchanging complete internal reasoning transcripts is not necessary to implement that contract.

## 6. Model Context Protocol Specification

**Authoring body:** Model Context Protocol contributors. **Version reviewed:** 2026-07-28.

The Model Context Protocol defines an interface through which AI applications access tools and contextual resources. It uses JSON-RPC messages and specifies conventions for requests, capabilities, and server-provided functionality. Its contribution is interoperability: an application can interact with services through a common protocol instead of inventing an entirely separate interface for every tool. As a specification, it establishes expected behavior rather than experimentally demonstrating improved task performance. [Source](https://modelcontextprotocol.io/specification/2026-07-28)

For the project, MCP could provide a consistent boundary between the agent runtime and external tools. Tool descriptions and input schemas explain which operations are available and what arguments they accept. The harness would still need to enforce permissions, correlate results with tasks, and decide whether a result satisfies an objective. Protocol compatibility does not resolve those application decisions. The implementation should pin a supported revision and test request, error, and transport behavior against it, particularly where existing examples target older versions.

## 7. Agent2Agent Protocol Specification

**Authoring body:** A2A Protocol contributors. **Version:** Living specification, accessed 16 September 2026.

The Agent2Agent protocol describes how independently implemented agent services exchange work. Its data model distinguishes messages, tasks, task status, and output artifacts. It also specifies mechanisms for retrieving task state, cancelling work, receiving streamed updates, and obtaining asynchronous notifications. These features make longer-running collaboration possible without requiring every participant to share the same internal framework. The specification defines interface behavior; it does not establish the quality of an agent’s decisions. [Source](https://a2a-protocol.org/latest/specification/)

A2A is particularly relevant to the project’s task lifecycle. A task should retain an identity and retrievable status even when a connection ends. Acknowledgment, progress, and completion should remain separate events, while outputs should be associated with the task that produced them. Applying these ideas would help the harness recover from disconnections and interpret late responses. It would still need explicit policies for duplicate requests and ambiguous execution outcomes. Full adoption is most useful when agents operate as separate services; smaller internal deployments can borrow the data-model principles.

## 8. What I Learned Building an Opinionated and Minimal Coding Agent

**Author:** Mario Zechner. **Year:** 2025; published 30 November.

Zechner’s account describes the design of Pi through separate layers: a unified model-provider API, an agent runtime, and a coding-agent application. The provider layer manages differences between model interfaces, while the runtime handles the repeated interaction between model output and tool execution. The discussion includes streaming, validation, and state management. This is a maintainer’s engineering account rather than a controlled research study, and its historical implementation should be distinguished from current package versions. [Source](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)

For the proposed harness, Pi illustrates where to place an adapter between provider-specific responses and internal events. Normalizing model messages would let the coordination layer work with a stable representation even when the underlying model changes. The runtime could expose events such as tool requests, execution results, and turn completion. Multi-agent routing would remain a separate responsibility. This separation would also support independent tests of the model adapter, individual worker loop, and cross-worker coordination logic.

## 9. Orchestration and Handoffs — OpenAI Agents SDK Documentation

**Organizational author:** OpenAI. **Version:** Living documentation, accessed 16 September 2026.

OpenAI’s orchestration documentation distinguishes agents invoked as tools from agents receiving control through a handoff. In the first pattern, a manager requests specialist assistance and retains responsibility for the final answer. In the second, a specialist takes over the conversation for its branch of work. These patterns make ownership an explicit part of the application design. They are implementation guidance, rather than comparative evidence that either arrangement is consistently superior. [Source](https://developers.openai.com/api/docs/guides/agents/orchestration)

For this project, the distinction determines how delegation messages should behave. A bounded request should return a result to its caller; a handoff should identify the new owner and provide the context needed to continue. The harness should record that distinction so multiple agents do not independently assume control of the same task. The Agents SDK also differs from the ordinary OpenAI client SDK: the latter supports API interaction, while the former supplies higher-level agent orchestration. [Client SDK documentation](https://developers.openai.com/api/docs/libraries)

## 10. Gemma 4 Usage Guide — vLLM

**Authoring body:** vLLM contributors. **Version:** Living documentation, accessed 16 September 2026.

The vLLM guide describes serving Gemma 4 through an OpenAI-compatible HTTP API. Its examples configure a client to contact a model server and use model-specific chat formatting, tool-call parsing, and reasoning parsing. This separates the application’s request format from the representation expected by the model. The guide documents an implementation path; compatibility remains dependent on the selected server release, checkpoint, and configuration. [Source](https://docs.vllm.ai/projects/recipes/en/stable/Google/Gemma4.html)

For communication “on the wire,” the harness sends API messages and tool definitions to the server, then receives generated text or structured tool requests. The serving stack translates between those messages and Gemma’s native representation. The harness must validate and execute permitted requests, then supply the corresponding tool results in the next interaction. If responses stream incrementally, execution should wait for a complete, validated tool request. An OpenAI-compatible endpoint supports model inference; inter-agent routing, shared state, and task ownership still belong in the surrounding architecture.

The proposed research can connect these sources by treating communication as an independently testable design variable. A useful comparison would hold the model, tools, environment, and inference budget constant while varying how tasks are assigned and observations are shared. Measurements should include verified completion, unsupported findings, duplicated work, stale-state decisions, recovery behavior, latency, and token usage. This would establish which communication choices help the specific research system without assuming that results from different papers and benchmarks are directly comparable.
