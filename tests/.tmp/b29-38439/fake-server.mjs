import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result })
  const replyErr = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } })
  switch (msg.method) {
    case "initialize": {
      const p = msg.params || {}
      if (p.protocolVersion !== '2024-11-05') return replyErr(-32602, 'bad protocolVersion: ' + p.protocolVersion)
      if (!p.clientInfo || p.clientInfo.name !== 'CODEZY') return replyErr(-32602, 'bad clientInfo')
      reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "0.0.1" } })
      break
    }
    case "notifications/initialized":
      break
    case "tools/list":
      reply({ tools: [
        { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
        { name: "boom", description: "Always reports an error" },
        { name: "slow", description: "Answers after 3 seconds" }
      ] })
      break
    case "tools/call": {
      const name = msg.params && msg.params.name
      const args = (msg.params && msg.params.arguments) || {}
      if (name === "echo") reply({ content: [{ type: "text", text: "echo:" + args.message }, { type: "image", data: "xxx" }] })
      else if (name === "boom") reply({ content: [{ type: "text", text: "kaboom" }], isError: true })
      else if (name === "slow") setTimeout(() => reply({ content: [{ type: "text", text: "late" }] }), 3000)
      else if (name === "crash") process.exit(3)
      else replyErr(-32602, "Unknown tool: " + name)
      break
    }
    default:
      if (msg.id !== undefined) replyErr(-32601, "Method not found: " + msg.method)
  }
})