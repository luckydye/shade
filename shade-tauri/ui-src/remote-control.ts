import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { executeRemoteControlTool } from "../../shade-ui/src/store/remote-control";

type RemoteControlRequest = {
  request_id: string;
  tool_name: string;
  arguments: unknown;
};

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function startRemoteControlBridge() {
  return listen<RemoteControlRequest>("remote-control-request", (event) => {
    void (async () => {
      const { request_id, tool_name, arguments: args } = event.payload;
      try {
        const result = await executeRemoteControlTool({
          name: tool_name,
          arguments: args,
        });
        await invoke("submit_remote_control_response", {
          params: {
            request_id,
            result,
          },
        });
      } catch (error) {
        await invoke("submit_remote_control_response", {
          params: {
            request_id,
            error: formatError(error),
          },
        });
      }
    })();
  });
}
