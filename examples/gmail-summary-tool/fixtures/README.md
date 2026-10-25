# Synthetic Gmail response fixtures

The TypeScript and Python examples share two synthetic server fixtures.
`canonical-gmail.json` preserves canonical v1 unchanged. Its root contains
`name`, `list`, and `messages`. `canonical-gmail-v2.json` adds `maxResults: 10` and
uses the name `canonical-gmail-v2`. Both contain the same five full messages and
single-page list response, without a next-page token.

Canonical v1 used a full page: five returned messages with `maxResults=5`. Its
earlier replay comparison matched five of six reads, with the list response as
the remaining boundary case. Canonical v2 is a separate server input that returns
fewer messages than the requested maximum. It does not replace that evidence or
claim that the earlier comparison passed.

Google's [`messages.list` reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
defines `maxResults` as the maximum number of returned messages, with a default
of 100 and a limit of 500. The v2 request sends ten on the wire. Its response
contains five messages and `resultSizeEstimate: 5`. The tool summarizes those
five messages. The captured request must retain the actual value ten.

The fixtures use an independently observed Gmail response structure. They contain
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

The server selects its fixture before capture. Capture assertions compare the
exported JSON with the selected server response. Neither recorded responses nor
replay results are rewritten to match the fixture. The original default fixture
and model-scope scenario remain separate.
