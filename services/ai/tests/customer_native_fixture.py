import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_customer_dispatch import fixture
from agents.copyeditor import get_agent
from tools import InMemoryExecutor
from customer_dispatch import AgentRequest
from customer_protocol import prepare_customer_request
from test_customer_provider import policy_for
scope, request = fixture()
chapter = request['input']['chapterIds'][0]
request['input']['chapters'][chapter]['documentVersionId'] = '00000000-0000-4000-8000-000000000002'
agent = get_agent('writer', None, InMemoryExecutor(chapters=request['input']['chapters']), scope['policy']['model'])
agent.max_output_tokens = 1024
messages, tools, choice = agent.provider_request({'workspaceId':scope['workspaceId'],'bookId':scope['bookId'],
    'chapterIds':[chapter], 'book':request['input']['book'], 'userInstruction':None,
    'contextPolicy':AgentRequest.model_validate(request).contextPolicy.model_dump()})
scope['expectedRequestSha256'] = prepare_customer_request('openai', policy_for('openai'), messages, tools,
    scope['policy']['model'], max_output_tokens=1024, tool_choice=choice).sha256
print(json.dumps([scope, request], ensure_ascii=False))
