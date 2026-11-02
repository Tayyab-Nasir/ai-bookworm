"""Disposable integration bridge: real Python DB HTTP adapter, fake provider only."""
import base64, json, sys
from urllib.parse import urlsplit
import httpx
from fastapi.testclient import TestClient
from customer_private_app import create_customer_private_app
from test_customer_dispatch import NOW, SIGNING_KEY, transport
from test_customer_database import DB_KEY
command=json.load(sys.stdin)
parts=urlsplit(command['databaseUrl'])
assert parts.scheme=='http' and parts.hostname=='127.0.0.1' and parts.port and parts.path==''
original=httpx.HTTPTransport.handle_request
def only_fixture(self, request):
    assert request.url.scheme=='http' and request.url.host=='127.0.0.1' and request.url.port==parts.port
    return original(self,request)
httpx.HTTPTransport.handle_request=only_fixture
calls=[]
app=create_customer_private_app(database_url=command['databaseUrl'],service_role_key=DB_KEY,
  deployment_id='deploy',service_id='service',service_token='synthetic-private-service-token',
  signing_keys={'synthetic':SIGNING_KEY},mode='test',allow_loopback_http=True,
  _test_provider_transport=transport('openai',calls),_test_clock=lambda:NOW)
wire=base64.b64decode(command['body'],validate=True)
with TestClient(app,headers={'x-service-token':'synthetic-private-service-token','content-type':'application/json'}) as client:
    first=client.post('/v1/internal/customer-text/dispatch',content=wire)
    replay=client.post('/v1/internal/customer-text/dispatch',content=wire)
    if first.status_code!=201 or replay.status_code!=201:
        print(json.dumps({'status':first.status_code,'replayStatus':replay.status_code,'providerCalls':len(calls)}));sys.exit(2)
    assert first.json()==replay.json() and len(calls)==1
    print(json.dumps({'status':first.status_code,'result':first.json(),'providerCalls':len(calls)}))
