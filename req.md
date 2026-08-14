# Requirements

I want to generate an JS SDK which can be used to chat with agent via WS/API/Streaming behaviour. The code for agent is at following location /Volumes/Data/code/moonshot/betterclaw/gwt/js_sdk

I want to have an API key to authenication between sdk consumer and my backend

The consumer (JS app) will send normal chat and agent/hub is responsible to manage the state of the chat. The UI/consumer of this sdk has to be as thin as possible. As we make improvement to hub/agent behaviour, this sdk will mature accordingly. 

### Question

Do we directly allow to chat with agent/via hub. I think via hub, because we also need to start sleeping agent. 