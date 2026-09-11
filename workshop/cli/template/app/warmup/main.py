"""HTTP lifecycle warmup. There is deliberately no model, AWS client, or tool call."""

import logging

from bedrock_agentcore.runtime import BedrockAgentCoreApp


app = BedrockAgentCoreApp()
logger = logging.getLogger("atlas_cli_warmup")
logger.setLevel(logging.INFO)
logger.propagate = False
if not logger.handlers:
    # `agentcore dev` imports this module; __main__ setup would not run.
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(handler)
PROJECT_NAME = "__ATLAS_PROJECT__"


@app.entrypoint
def invoke(payload):
    """Return deterministic JSON; accept the CLI's {"prompt": "..."} envelope."""
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    if not isinstance(prompt, str) or len(prompt) > 512:
        return {
            "error": "invalid_prompt",
            "message": "prompt는 512자 이하의 문자열이어야 합니다.",
            "modelInvoked": False,
        }
    logger.info(
        "warmup_complete project=%s prompt_chars=%d model_invoked=false",
        PROJECT_NAME, len(prompt),
    )
    return {
        "project": PROJECT_NAME,
        "mode": "deterministic",
        "message": "AgentCore CLI Runtime 연결을 확인했습니다.",
        "echo": prompt,
        "modelInvoked": False,
    }


if __name__ == "__main__":
    app.run()
