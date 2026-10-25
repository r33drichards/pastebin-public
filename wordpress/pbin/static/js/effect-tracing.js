// Bridges Effect's tracer to the paste's OpenTelemetry shim
// (@opentelemetry/api → otel-shim.js), so Effect.withSpan spans land in the
// same waterfall as manual OTel spans — with correct parenting under
// concurrency, since Effect carries the parent span on its fibers.
//
// Served at 'pbin/effect-tracing' in the run's virtual filesystem (next to
// the bundled or URL-imported modules; see code-runner.js). Does NOT import
// 'effect' itself: the paste chooses a bundled or URL-imported copy, and a layer
// built from a second copy of the library would not compose with it. The
// paste hands its modules in instead:
//
//   import { Effect, Tracer, Layer, Cause } from 'pbin/effect@3.12.0';
//   import { makeEffectTracing } from 'pbin/effect-tracing';
//
//   const TracingLive = makeEffectTracing({ Tracer, Layer, Cause });
//   await Effect.runPromise(program.pipe(Effect.provide(TracingLive)));
//
// Cause is optional (error messages degrade gracefully without it).

import { trace as otelTrace, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';

const shimTracer = otelTrace.getTracer('effect');

// Effect SpanKind strings → the OTel numeric kinds the shim uses.
const KINDS = { internal: 0, server: 1, client: 2, producer: 3, consumer: 4 };

export function makeEffectTracing(modules) {
  if (!modules || !modules.Tracer || !modules.Layer) {
    throw new TypeError("makeEffectTracing needs the paste's own Effect modules: { Tracer, Layer, Cause? }");
  }
  const { Tracer, Layer, Cause } = modules;

  function makeSpan(name, parent, context, links, startTime, kind) {
    // Parent is an Option<AnySpan>; spans this adapter made carry their shim
    // span on _otel. An external parent (ids only) can't be linked in the
    // shim, so such a span starts a fresh trace.
    let parentCtx;
    if (parent && parent._tag === 'Some' && parent.value && parent.value._otel) {
      parentCtx = otelTrace.setSpan(ROOT_CONTEXT, parent.value._otel);
    }
    const span = shimTracer.startSpan(name, { kind: KINDS[kind] ?? 0, root: !parentCtx }, parentCtx);
    const sc = span.spanContext();
    const attributes = new Map();
    return {
      _tag: 'Span',
      _otel: span,
      name,
      spanId: sc.spanId,
      traceId: sc.traceId,
      parent,
      context,
      links,
      sampled: true,
      kind,
      attributes,
      status: { _tag: 'Started', startTime },
      attribute(key, value) {
        attributes.set(key, value);
        span.setAttribute(key, value);
      },
      event(eventName, _eventTime, attrs) {
        span.addEvent(eventName, attrs);
      },
      addLinks(newLinks) {
        this.links = [...this.links, ...newLinks];
      },
      end(endTime, exit) {
        this.status = { _tag: 'Ended', startTime, endTime, exit };
        if (exit && exit._tag === 'Failure') {
          let message;
          try {
            message = Cause && Cause.pretty ? Cause.pretty(exit.cause) : String(exit.cause);
          } catch (e) {
            message = 'failed';
          }
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        }
        span.end();
      },
    };
  }

  return Layer.setTracer(Tracer.make({
    span: makeSpan,
    context: (f, _fiber) => f(),
  }));
}
