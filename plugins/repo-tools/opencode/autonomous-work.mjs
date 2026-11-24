// OpenCode server plugin for resuming stalled turns in sessions granted
// autonomy via the autonomous-work skill. Shares decision logic with the
// Claude Code, Codex, and Antigravity Stop hooks.
import { runStopHookPayload } from '../scripts/repo-autonomous-work-hook.mjs';

// OpenCode activates skills through its skill tool. Reading SKILL.md or
// printing it is inspection, not activation.
function isAutonomousSkillTool(tool, args) {
  if (String(tool ?? '').toLowerCase() !== 'skill') return false;
  const requested = String(args?.name ?? args?.skill ?? '').trim().replace(/^[/$]/, '');
  return requested === 'autonomous-work' || requested.endsWith(':autonomous-work');
}

export const AutonomousWorkMonitor = async ({ client, directory } = {}) => {
  if (!client?.session) return {};

  const childSessions = new Set();
  const blockedSessions = new Set();
  const activatedSessions = new Set();
  const inFlight = new Set();

  async function handleSessionIdle(sessionID) {
    if (!sessionID || childSessions.has(sessionID) || blockedSessions.has(sessionID) || inFlight.has(sessionID)) {
      return;
    }
    inFlight.add(sessionID);
    try {
      const sessionResp = await client.session.get({ path: { id: sessionID } });
      const info = sessionResp?.data;
      if (!info) return;
      if (info.parentID) {
        childSessions.add(sessionID);
        return;
      }
      if (blockedSessions.has(sessionID)) return;

      const messagesResp = await client.session.messages({ path: { id: sessionID } });
      const messages = messagesResp?.data;
      if (!Array.isArray(messages)) return;

      const { decision } = runStopHookPayload(
        {
          sessionID,
          info,
          messages,
          blocked: blockedSessions.has(sessionID),
          autonomousActivated: activatedSessions.has(sessionID),
        },
        { harness: 'opencode' },
      );

      if (!decision.shouldContinue || blockedSessions.has(sessionID)) return;

      await client.session.promptAsync({
        path: { id: sessionID },
        ...(info.directory || directory ? { query: { directory: info.directory ?? directory } } : {}),
        body: {
          parts: [{ type: 'text', text: decision.message }],
        },
      });
    } catch {
      // Never disturb the host OpenCode session if inspection or prompt submission fails.
    } finally {
      inFlight.delete(sessionID);
    }
  }

  return {
    'chat.message': async ({ sessionID }) => {
      if (sessionID) blockedSessions.delete(sessionID);
    },
    'tool.execute.after': async (input) => {
      const sessionID = input?.sessionID;
      if (!sessionID || childSessions.has(sessionID)) return;
      if (isAutonomousSkillTool(input.tool, input.args)) {
        activatedSessions.add(sessionID);
      }
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = typeof properties.sessionID === 'string' ? properties.sessionID : undefined;

      switch (type) {
        case 'session.created': {
          const info = properties.info;
          if (info?.id && info.parentID) {
            childSessions.add(info.id);
          }
          break;
        }
        case 'permission.asked':
        case 'question.asked':
        case 'session.error':
          if (sessionID) blockedSessions.add(sessionID);
          break;
        case 'permission.replied':
        case 'question.replied':
        case 'question.rejected':
          if (sessionID) blockedSessions.delete(sessionID);
          break;
        case 'session.idle':
          if (sessionID) await handleSessionIdle(sessionID);
          break;
        case 'session.deleted': {
          const id = properties.info?.id ?? sessionID;
          if (id) {
            childSessions.delete(id);
            blockedSessions.delete(id);
            activatedSessions.delete(id);
          }
          break;
        }
        default:
          break;
      }
    },
  };
};

export default AutonomousWorkMonitor;
