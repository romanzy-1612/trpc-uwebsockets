import { test, expect } from 'vitest';
import uWs from 'uWebSockets.js';

// source: packages/server/src/adapters/node-http/incomingMessageToRequest.test.ts

// this is needed to show nodes internal errors
// source: https://stackoverflow.com/questions/78946606/use-node-trace-warnings-to-show-where-the-warning-was-created
process.on('warning', (warning) => {
  console.warn('warning stacktrace - ' + warning.stack);
});

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

import {
  decorateHttpResponse,
  uWsToRequest,
  uWsSendResponse,
} from './fetchCompat';

function createServer(opts: { maxBodySize: number | null }) {
  const app = uWs.App();

  app.get('/smoke', async (res, _req) => {
    const resDecorated = decorateHttpResponse(res);

    res.onAborted(() => {
      resDecorated.aborted = true;
    });

    const headers = new Headers();
    headers.append('content-type', 'vi/test');
    headers.append('set-cookie', 'one=1');
    headers.append('set-cookie', 'two=2');

    const resFetch = new Response('hello world', {
      status: 200,
      statusText: '200 OK',
      headers: headers,
    });

    await uWsSendResponse(resDecorated, resFetch);
  });

  // app.any('/*', async (res, req) => {
  //   const resDecorated = decorateHttpResponse(res);

  //   const request = uWsToRequest(req, resDecorated, opts);
  //   console.log('request', request);
  //   const reqBody = await request.json();
  //   console.log('reqBody', reqBody);

  //   const headers = new Headers();

  //   if ('headers' in reqBody) {
  //     const desiredHeaders = reqBody['headers'] as {
  //       name: string;
  //       value: string;
  //     }[];

  //     desiredHeaders.forEach(({ name, value }) => {
  //       headers.append(name, value);
  //     });
  //   }

  //   // lets produce a response
  //   const resFetch = new Response(reqBody.body, {
  //     status: reqBody.status,
  //     statusText: reqBody.statusText,
  //     headers: headers,
  //   });

  //   await uWsSendResponse(resDecorated, resFetch);
  // });

  let socket: uWs.us_listen_socket | false | null = null;

  app.listen('0.0.0.0', 0, (token) => {
    socket = token;
  });

  if (!socket) {
    throw new Error('could not make a socket');
  }

  const port = uWs.us_socket_local_port(socket);
  // console.log('Listening to port ' + port);

  return {
    async close() {
      // donest need to be async, but for compat
      if (!socket) {
        throw new Error('could not close socket as socket is already closed');
      }
      uWs.us_listen_socket_close(socket);
      socket = null;
    },
    fetch: async (
      opts: RequestInit & {
        path?: string;
      }
    ) => {
      return await fetch(`http://localhost:${port}${opts.path ?? ''}`, {
        ...opts,
      });
    },
  };
}

test.sequential('smoke', async () => {
  const server = createServer({ maxBodySize: null });
  const res = await server.fetch({
    path: '/smoke',
    method: 'GET',
  });

  expect(res.ok).toBe(true);
  expect(res.status).toBe(200);
  expect(res.statusText).toBe('OK');
  expect(res.headers.get('content-type')).toBe('vi/test');
  expect(res.headers.get('set-cookie')).toBe('one=1, two=2');

  await server.close();
});

// test.sequential('megatest', async () => {
//   const server = createServer({ maxBodySize: null });
//   const res = await server.fetch({
//     method: 'POST',
//     body: JSON.stringify({
//       body: 'hello world',
//       status: 200,
//       statusText: '200 OK',
//       headers: [{ name: 'name', value: 'value' }],
//     }),
//   });

//   expect(res.ok).toBe(true);

//   await server.close();
// });