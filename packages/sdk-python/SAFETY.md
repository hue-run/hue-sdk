# Python content safety

`set_input`, `set_output` and inference-log content helpers detach application content before passing it to a redactor. Dictionaries and lists remain dictionaries and lists; nested mutable values are copied too. Built-in tuples retain their shape. A redactor can change this private copy in place and return it, or raise, without changing the caller's arguments, result or original application exception.

Content capture must be enabled explicitly. Disabled clients and metadata-only capture do not run content snapshots or redactors. Arbitrary OpenTelemetry attributes, third-party instrumentors and other exporters have separate policies.

## Supported values and budgets

The snapshots accept ordinary built-in dictionaries, lists, tuples, strings, integers, finite floats, booleans and `None`. Dictionary keys may be strings or the scalar key types accepted by Python's JSON encoder (`int`, finite `float`, `bool`, `None`). Custom classes and subclasses are rejected; the snapshot never uses `deepcopy`, custom copy methods or custom container iterators. Convert model objects explicitly to ordinary built-in values before capturing them.

Every captured value is checked before redaction, including when no redactor is configured. The redactor's returned value is checked again before JSON serialization. Each check has an independent limit:

- A 1 MiB conservative value budget: eight bytes per visited value/key, plus UTF-8 string bytes and conservative numeric conversion overhead. This is a traversal bound, not a measurement of process memory or serialized JSON size.
- Integers, including dictionary keys, have at most 14,000 bits of magnitude (about 4,215 decimal digits), independently of Python's configurable integer-string limit. This bounds decimal conversion work before serialization.
- Maximum nesting depth 64, with the root at depth zero.
- At most 65,536 visited values and dictionary keys. Repeated references count again; cycles are rejected.

The final UTF-8 JSON field must fit 256 KiB. A redactor can reduce a larger input only if the input fits the snapshot limits. Unsupported values, nonfinite numbers, cycles, exhausted budgets, redactor exceptions and serialization failures omit the content and increment `export_status.instrumentation_failures`; they do not raise into the application's traced operation. If an inference-log field fails, that log emission is omitted. Failure counters remain visible through flush/status checks.

## Callback boundary

Redactors run synchronously in the application process. Keep them bounded and prompt. Detached arguments protect against mutation through those arguments; they do not sandbox callback code, preempt a blocked callback, or prevent side effects through a closure or global state. No exception message or rejected content is copied into diagnostic counters.
