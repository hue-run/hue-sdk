# Synthetic Gmail response fixtures

`canonical-gmail.json` is a separate synthetic server fixture shared by the
TypeScript and Python examples. Its root contains `name`, `list`, and `messages`.
`list` is a single-page `messages.list` response. `messages` contains the five
corresponding `messages.get?format=full` responses.

The fixture uses an independently observed Gmail response structure. It contains
only invented message content, addresses under `example.test`, and synthetic
identifiers. No customer values were copied. This structure observation is not a
Google-published response example.

Google's [Message and MessagePart reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
describes `internalDate` as epoch milliseconds, `historyId` as the last modifying
history record, and `partId` as an immutable part identifier. The synthetic
messages have distinct descending `internalDate` values and one shared synthetic
history record. Google's [list guide](https://developers.google.com/workspace/gmail/api/guides/list-messages)
documents newest-first order. Its [history reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)
describes chronologically increasing history IDs with gaps.

The observed plain-text root structure includes empty `partId` and `filename`
strings, a header array, and an inline body object. It has no child `parts` or
`attachmentId`. Google's reference describes `filename` as an attachment field;
it does not establish that these empty root fields are required. This fixture
does not imply that the original fixture's omissions are invalid Gmail.

The server selects this fixture before capture. Capture assertions compare the
exported JSON with the selected server response. Neither recorded responses nor
replay results are rewritten to match the fixture. The original default fixture
and model-scope scenario remain separate.
