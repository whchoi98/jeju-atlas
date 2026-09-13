# 01. 준비된 환경 확인

이 장은 10분입니다. 이미 설치된 VSCode Server와 AI CLI를 확인합니다.
VPC, NAT Gateway, Subnet과 VSCode Server를 새로 설치하는 과정은 없습니다.
모든 명령은 VSCode Server의 EC2 터미널에서 실행합니다.

## 사용할 AI CLI 선택

설치된 세 도구 중 하나를 선택합니다.
같은 파일을 여러 CLI에서 동시에 수정하지 않습니다.

| 도구 | 버전 확인 | 실행 |
|---|---|---|
| Codex | `codex --version` | `codex` |
| Kiro CLI | `kiro-cli --version` | `kiro-cli chat` |
| Claude Code | `claude --version` | `claude` |

터미널에서 대화를 시작할 수 있는지 확인한 뒤 종료합니다.
로그인이 필요하면 진행자가 준비한 계정으로 로그인합니다.
설치된 도구를 다시 설치하거나 기존 인증 파일을 교체하지 않습니다.
[도구별 안내](../reference/ai-cli-environments.md)에 작업 폴더를 여는 방법이 있습니다.

## 실습 명령 확인

```bash
cd /home/ec2-user/my-project/jeju-atlas
export ATLAS_REPO="$PWD"
node --version
python3 --version
uv --version
aws --version
agentcore --version
agentcore create --help
```

이 교재의 명령은 npm 패키지 `@aws/agentcore` 0.28.1에서 확인했습니다.
Node는 24 계열이며 Runtime 코드는 Python 3.14를 사용합니다.
CLI가 없거나 버전이 다르면 진행자가 준비한 도구 경로를 사용합니다.
120분 수업 중에 전역 CLI를 업그레이드하지 않습니다.

이전 Python starter toolkit과 npm AgentCore CLI는 명령과 설정 파일이 다릅니다.
이 수업에서는 `agentcore/agentcore.json`과 `agentcore/aws-targets.json`을 사용합니다.

## Python과 패키지 준비 상태

```bash
uv python find 3.14
python3 -c "import boto3, requests; print('workshop dependencies ready')"
```

첫 명령은 Python 3.14 경로를, 둘째 명령은 준비 완료 문구를 출력해야 합니다.
진행자는 수업 전에 의존성을 설치합니다. 참가자는 준비된 환경을 그대로 사용합니다.
빠진 도구를 발견했다면 설치 대기로 시간을 쓰지 말고 진행자에게 알립니다.

Docker는 05장 이후의 컨테이너 실습에서 사용합니다.
본 실습은 CodeZip 방식이므로 참가자가 컨테이너 이미지를 빌드하지 않습니다.

프롬프트: [환경 확인](../prompts/01-setup.md)

다음: [02. 계정과 작업 폴더](02-aws-environment.md)
