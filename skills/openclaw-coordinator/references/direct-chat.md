# Direct conversations and tasks

Use direct chat for questions and conversational work that should return to the calling client. Retain the returned session identifier to continue the same conversation rather than starting over.

Use the asynchronous task workflow for work that should continue without holding the chat call open. Keep the task identifier and use the task tools when the user needs progress, results or cancellation. A client disconnect does not establish that the task stopped. Follow the tools' connection and ownership requirements.

Select an agent when the request calls for one. If the user wants a particular model, discover the selectable models for that agent first. Model selection is available only where the advertised tool exposes it; continuing a conversation is not a request to change its model.

Choose Discord instead when the user wants a shared place to continue the work. Discord work can also run for a long time, but it uses thread handoff rather than the direct asynchronous task API.
