// Tools the bridge gives to DSH agents (R3.3, R3.5). The caller is the session
// that runs the tool (`exec.agent.session`), so `from` is never a parameter.
// Shapes follow @deepseek-ai/dsh-tools `defineTool` (docs/spikes/dsh-tools.md).

const short = (id) => String(id ?? '').replace(/^session-/, '').slice(0, 8)

export function bridgeTools(messenger) {
  return [
    {
      name: 'bridge_ping',
      description: 'Send a short message to another agent through dsh-agent-bridge: a review request, a result, a question or a done notice. The summary points to the work (PR, branch, sha); the receiver reads the details itself. Use inReplyTo to answer a message you received.',
      parameters: {
        to: { type: 'string', required: true, description: 'receiver: an agent name such as "reviewer", or dsh:<session id prefix>' },
        kind: { type: 'string', required: true, description: 'ping, review-request, review-result, question or done' },
        summary: { type: 'string', required: true, description: 'at most 2000 characters' },
        inReplyTo: { type: 'string', description: 'msg-<id> of the message you answer' },
        threadId: { type: 'string', description: 'thr-<id> to continue a thread' },
        repo: { type: 'string', description: 'owner/name of the repository' },
        branch: { type: 'string' },
        sha: { type: 'string' },
        pr: { type: 'integer' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: `Sent ${value.id} to ${value.to} (thread ${value.threadId}, hop ${value.hop}).` }],
      },
      async execute(args, exec) {
        const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
        if (!sessionId) throw new Error('bridge_ping needs a calling DSH session')
        const ref = {}
        for (const key of ['repo', 'branch', 'sha', 'pr']) if (args[key] !== undefined) ref[key] = args[key]
        const message = await messenger.send({
          to: args.to, kind: args.kind, summary: args.summary, inReplyTo: args.inReplyTo, threadId: args.threadId,
          ...(Object.keys(ref).length ? { ref } : {}),
        }, `dsh:${short(sessionId)}`)
        return { id: message.id, threadId: message.threadId, hop: message.hop, from: message.from, to: message.to }
      },
    },
  ]
}
