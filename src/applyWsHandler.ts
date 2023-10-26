import type { CompressOptions, TemplatedApp, WebSocket } from 'uWebSockets.js';

import {
  AnyRouter,
  inferRouterContext,
  TRPCError,
  callProcedure,
  getTRPCErrorFromUnknown,
  MaybePromise,
} from '@trpc/server';
import { NodeHTTPCreateContextOption } from '@trpc/server/adapters/node-http';
import type { BaseHandlerOptions } from '@trpc/server/src/internals/types';
import { Unsubscribable, isObservable } from '@trpc/server/observable';
import {
  TRPCClientOutgoingMessage,
  TRPCResponseMessage,
  JSONRPC2,
  TRPCReconnectNotification,
  parseTRPCMessage,
} from '@trpc/server/rpc';

// import { transformTRPCResponse } from '../shared/transformTRPCResponse';
import { getErrorShape, transformTRPCResponse } from '@trpc/server/shared';
import { WrappedHTTPRequest } from './types';
import { extractAndWrapHttpRequest } from './utils';


type UWSBuiltInOpts = {
  /** Maximum length of received message. If a client tries to send you a message larger than this, the connection is immediately closed. Defaults to 16 * 1024. */
  maxPayloadLength?: number;
  /** Whether or not we should automatically close the socket when a message is dropped due to backpressure. Defaults to false. */
  closeOnBackpressureLimit?: number;
  /** Maximum number of minutes a WebSocket may be connected before being closed by the server. 0 disables the feature. */
  maxLifetime?: number;
  /** Maximum amount of seconds that may pass without sending or getting a message. Connection is closed if this timeout passes. Resolution (granularity) for timeouts are typically 4 seconds, rounded to closest.
   * Disable by using 0. Defaults to 120.
   */
  idleTimeout?: number;
  /** What permessage-deflate compression to use. uWS.DISABLED, uWS.SHARED_COMPRESSOR or any of the uWS.DEDICATED_COMPRESSOR_xxxKB. Defaults to uWS.DISABLED. */
  compression?: CompressOptions;
  /** Maximum length of allowed backpressure per socket when publishing or sending messages. Slow receivers with too high backpressure will be skipped until they catch up or timeout. Defaults to 64 * 1024. */
  maxBackpressure?: number;
  /** Whether or not we should automatically send pings to uphold a stable connection given whatever idleTimeout. */
  sendPingsAutomatically?: boolean;
};

/**
 * Web socket server handler
 */
export type WSSHandlerOptions<TRouter extends AnyRouter> = BaseHandlerOptions<
  TRouter,
  WrappedHTTPRequest
  //   IncomingMessage
> &
  NodeHTTPCreateContextOption<TRouter, WrappedHTTPRequest, any> &
  UWSBuiltInOpts;

type Decoration = {
  clientSubscriptions: Map<number | string, Unsubscribable>;
  ctxPromise: MaybePromise<inferRouterContext<AnyRouter>> | undefined;
  ctx: inferRouterContext<AnyRouter> | undefined;
  req: WrappedHTTPRequest;
};

export function applyWSHandler<TRouter extends AnyRouter>(
  app: TemplatedApp,
  prefix: string,
  opts: WSSHandlerOptions<TRouter>
) {
  const { createContext, router } = opts;

  const { transformer } = router._def._config;

  // instead of putting data on the client, can put it here in a global map
  // const globals = new Map<WebSocket<any>, Decoration>();

  // doing above can eliminate allClients for reconnection notification
  const allClients = new Set<WebSocket<Decoration>>();



  function respond(
    client: WebSocket<Decoration>,
    untransformedJSON: TRPCResponseMessage
  ) {

      client.send(
        JSON.stringify(
          transformTRPCResponse(router._def._config, untransformedJSON)
        )
      );

  }

  function stopSubscription(
    client: WebSocket<Decoration>,
    subscription: Unsubscribable,
    { id, jsonrpc }: JSONRPC2.BaseEnvelope & { id: JSONRPC2.RequestId }
  ) {
    subscription.unsubscribe();

    respond(client, {
      id,
      jsonrpc,
      result: {
        type: 'stopped',
      },
    });
  }

  async function handleRequest(
    client: WebSocket<Decoration>,
    msg: TRPCClientOutgoingMessage
  ) {
    const data = client.getUserData();
    const clientSubscriptions = data.clientSubscriptions;

    const { id, jsonrpc } = msg;
    /* istanbul ignore next -- @preserve */
    if (id === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '`id` is required',
      });
    }
    if (msg.method === 'subscription.stop') {
      const sub = clientSubscriptions.get(id);
      if (sub) {
        stopSubscription(client, sub, { id, jsonrpc });
      }
      clientSubscriptions.delete(id);
      return;
    }
    const { path, input } = msg.params;
    const type = msg.method;
    try {
      await data.ctxPromise; // asserts context has been set

      const result = await callProcedure({
        procedures: router._def.procedures,
        path,
        rawInput: input,
        ctx: data.ctx,
        type,
      });

      if (type === 'subscription') {
        if (!isObservable(result)) {
          throw new TRPCError({
            message: `Subscription ${path} did not return an observable`,
            code: 'INTERNAL_SERVER_ERROR',
          });
        }
      } else {
        // send the value as data if the method is not a subscription
        respond(client, {
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result,
          },
        });
        return;
      }

      const observable = result;
      const sub = observable.subscribe({
        next(data) {
          respond(client, {
            id,
            jsonrpc,
            result: {
              type: 'data',
              data,
            },
          });
        },
        error(err) {
          const error = getTRPCErrorFromUnknown(err);
          opts.onError?.({
            error,
            path,
            type,
            ctx: data.ctx,
            req: data.req,
            input,
          });
          respond(client, {
            id,
            jsonrpc,
            error: getErrorShape({
              config: router._def._config,
              error,
              type,
              path,
              input,
              ctx: data.ctx,
            }),
          });
        },
        complete() {
          respond(client, {
            id,
            jsonrpc,
            result: {
              type: 'stopped',
            },
          });
        },
      });
      /* istanbul ignore next -- @preserve */
      // FIXME handle these edge cases
      //   if (client.readyState !== client.OPEN) {
      //     // if the client got disconnected whilst initializing the subscription
      //     // no need to send stopped message if the client is disconnected
      //     sub.unsubscribe();
      //     return;
      //   }

      /* istanbul ignore next -- @preserve */
      if (clientSubscriptions.has(id)) {
        // duplicate request ids for client
        stopSubscription(client, sub, { id, jsonrpc });
        throw new TRPCError({
          message: `Duplicate id ${id}`,
          code: 'BAD_REQUEST',
        });
      }
      clientSubscriptions.set(id, sub);

      respond(client, {
        id,
        jsonrpc,
        result: {
          type: 'started',
        },
      });
    } catch (cause) /* istanbul ignore next -- @preserve */ {
      // procedure threw an error
      const error = getTRPCErrorFromUnknown(cause);
      opts.onError?.({
        error,
        path,
        type,
        ctx: data.ctx,
        req: data.req,
        input,
      });
      respond(client, {
        id,
        jsonrpc,
        error: getErrorShape({
          config: router._def._config,
          error,
          type,
          path,
          input,
          ctx: data.ctx,
        }),
      });
    }
  }

  app.ws(prefix, {
    sendPingsAutomatically: opts.sendPingsAutomatically, // could this be enabled?
    closeOnBackpressureLimit: opts.closeOnBackpressureLimit,
    compression: opts.compression,
    maxBackpressure: opts.maxBackpressure,
    maxPayloadLength: opts.maxPayloadLength,
    maxLifetime: opts.maxLifetime,
    idleTimeout: opts.idleTimeout,

    upgrade: (res, req, context) => {
      const wrappedReq = extractAndWrapHttpRequest(prefix, req);

      const secWebSocketKey = wrappedReq.headers['sec-websocket-key'];
      const secWebSocketProtocol = wrappedReq.headers['sec-websocket-protocol'];
      const secWebSocketExtensions =
        wrappedReq.headers['sec-websocket-extensions'];

      const data: Decoration = {
        clientSubscriptions: new Map<number | string, Unsubscribable>(),
        req: wrappedReq,
        ctx: undefined,
        ctxPromise: createContext?.({ req: wrappedReq, res }), // this cannot use RES!
      };

      res.upgrade(
        data,
        /* Spell these correctly */
        secWebSocketKey,
        secWebSocketProtocol,
        secWebSocketExtensions,
        context
      );
    },
    async open(client: WebSocket<Decoration>) {
      async function createContextAsync() {
        const data = client.getUserData();

        try {
          data.ctx = await data.ctxPromise;
        } catch (cause) {
          const error = getTRPCErrorFromUnknown(cause);

          opts.onError?.({
            error,
            path: undefined,
            type: 'unknown',
            ctx: data.ctx,
            req: data.req,
            input: undefined,
          });
          respond(client, {
            id: null,
            error: getErrorShape({
              config: router._def._config,
              error,
              type: 'unknown',
              path: undefined,
              input: undefined,
              ctx: data.ctx,
            }),
          });

          // large timeout is needed in order for response above to reach the client
          // otherwise it tries to reconnect over and over again, even though the context throws
          // this is a rouch edge of uWs
          setTimeout(() => {
            client.end()
          }, 1000)

          // original code
          // (global.setImmediate ?? global.setTimeout)(() => {
          // client.end()
          // });
        }
      }
      await createContextAsync();
      allClients.add(client);
    },

    async message(client: WebSocket<Decoration>, rawMsg) {
      try {
        const stringMsg = Buffer.from(rawMsg).toString();

        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const msgJSON: unknown = JSON.parse(stringMsg);

        const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
        const promises = msgs
          .map((raw) => parseTRPCMessage(raw, transformer))
          .map((value) => handleRequest(client, value));

        await Promise.all(promises);
      } catch (cause) {
        const error = new TRPCError({
          code: 'PARSE_ERROR',
          cause,
        });

        respond(client, {
          id: null,
          error: getErrorShape({
            config: router._def._config,
            error,
            type: 'unknown',
            path: undefined,
            input: undefined,
            ctx: undefined,
          }),
        });
      }
    },

    close(client: WebSocket<Decoration>) {
      const data = client.getUserData();

      for (const sub of data.clientSubscriptions.values()) {
        sub.unsubscribe();
      }
      data.clientSubscriptions.clear();
      allClients.delete(client);
    },
  });

  return {
    broadcastReconnectNotification: () => {
      const response: TRPCReconnectNotification = {
        id: null,
        method: 'reconnect',
      };
      const data = JSON.stringify(response);
      allClients.forEach((v) => {
        v.send(data);
      });
    },
  };
}
