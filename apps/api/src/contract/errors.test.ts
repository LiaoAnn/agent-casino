import { Exit, Schema, SchemaAST } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  apiError,
  apiErrors,
  ERROR_CODES,
  ERROR_STATUS,
  type ErrorCode,
} from './errors';

const decodes = (schema: Schema.Top, value: unknown): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(value),
  );

const statusOf = (schema: Schema.Top): number | undefined =>
  SchemaAST.resolveAt<number>('httpApiStatus')(schema.ast);

const errorBody = (code: ErrorCode) => ({
  status: 'error',
  code,
  message: 'Something went wrong; do this instead',
  hint: 'Call GET /v1/rooms/r_abcde12345/wait',
  retryable: false,
});

describe('ERROR_STATUS', () => {
  it('maps every error code to the HTTP status from A4', () => {
    expect(ERROR_STATUS).toEqual({
      invalid_request: 400,
      invalid_action: 400,
      name_invalid: 400,
      invalid_token: 401,
      name_banned: 403,
      wrong_invite_code: 403,
      room_not_found: 404,
      not_found: 404,
      not_your_turn: 409,
      stale_turn: 409,
      room_full: 409,
      match_over: 409,
      name_in_use: 409,
      unavailable: 503,
      internal: 500,
    });
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(ERROR_STATUS).sort());
  });
});

describe('apiError', () => {
  it('builds the shared error shape without a state key by default', () => {
    const error = apiError(
      'room_not_found',
      'Room r_abcde12345 does not exist',
      'Check the room_id you were given',
    );
    expect(error).toEqual({
      status: 'error',
      code: 'room_not_found',
      message: 'Room r_abcde12345 does not exist',
      hint: 'Check the room_id you were given',
      retryable: false,
    });
    expect(Object.keys(error)).not.toContain('state');
  });

  it('defaults retryable to true only for invalid_action and unavailable', () => {
    const retryable = ERROR_CODES.filter(
      code => apiError(code, 'm', 'h').retryable,
    );
    expect(retryable.sort()).toEqual(['invalid_action', 'unavailable']);
  });

  it('lets callers override retryable and attach state', () => {
    const state = {
      status: 'waiting',
      room_status: 'waiting',
      opponent_name: null,
      display_name: 'alice',
      opponent_display_name: null,
      settings: {
        max_hands: 10,
        turn_seconds: 60,
        blind_every: 50,
        starting_stack: 40,
      },
      to_act_seat: null,
      hand_number: null,
      view: null,
      hint: 'Call wait again',
    } as const;
    const error = apiError('stale_turn', 'm', 'h', { retryable: true, state });
    expect(error.retryable).toBe(true);
    expect(error.state).toEqual(state);
  });
});

describe('not_found', () => {
  it('is a 404 code that is not retryable by default', () => {
    expect(ERROR_CODES).toContain('not_found');
    expect(ERROR_STATUS.not_found).toBe(404);
    const error = apiError(
      'not_found',
      'No route for GET /nope',
      'Read GET /skill.md for the list of endpoints',
    );
    expect(error).toEqual({
      status: 'error',
      code: 'not_found',
      message: 'No route for GET /nope',
      hint: 'Read GET /skill.md for the list of endpoints',
      retryable: false,
    });
  });
});

describe('apiErrors', () => {
  it('returns one schema per distinct HTTP status, annotated with it', () => {
    const schemas = apiErrors('stale_turn', 'room_not_found', 'not_your_turn');
    expect(schemas).toHaveLength(2);
    const statuses = schemas.map(s => statusOf(s));
    expect(statuses.sort()).toEqual([404, 409]);
  });

  it('accepts exactly the listed codes of each status', () => {
    const schemas = apiErrors('stale_turn', 'room_not_found', 'not_your_turn');
    const schema409 = schemas.find(s => statusOf(s) === 409);
    if (schema409 === undefined) throw new Error('no 409 schema');
    expect(decodes(schema409, errorBody('stale_turn'))).toBe(true);
    expect(decodes(schema409, errorBody('not_your_turn'))).toBe(true);
    expect(decodes(schema409, errorBody('room_full'))).toBe(false);
    expect(decodes(schema409, errorBody('room_not_found'))).toBe(false);
  });

  it('decodes an error that carries a state', () => {
    const [schema] = apiErrors('match_over');
    if (schema === undefined) throw new Error('no schema');
    expect(statusOf(schema)).toBe(409);
    const body = {
      ...errorBody('match_over'),
      state: {
        status: 'match_over',
        room_status: 'finished',
        opponent_name: 'bob',
        display_name: 'alice',
        opponent_display_name: 'bob',
        settings: {
          max_hands: 10,
          turn_seconds: 60,
          blind_every: 50,
          starting_stack: 40,
        },
        to_act_seat: null,
        hand_number: 10,
        view: null,
        hint: 'Report the result to your owner',
        match_id: 'r_abcde12345',
        result: 'cancelled',
        final_stacks: [40, 40],
        ratings: null,
        last_hand: null,
      },
    };
    expect(decodes(schema, body)).toBe(true);
    expect(decodes(schema, { ...body, state: { status: 'nope' } })).toBe(false);
  });

  it('rejects bodies missing required fields', () => {
    const [schema] = apiErrors('invalid_token');
    if (schema === undefined) throw new Error('no schema');
    expect(statusOf(schema)).toBe(401);
    const { hint: _hint, ...noHint } = errorBody('invalid_token');
    expect(decodes(schema, noHint)).toBe(false);
    expect(
      decodes(schema, { ...errorBody('invalid_token'), status: 'ok' }),
    ).toBe(false);
  });
});

describe('name_in_use (A17)', () => {
  it('is a declared 409 error and is not retryable by default', () => {
    expect(ERROR_CODES).toContain('name_in_use');
    expect(ERROR_STATUS.name_in_use).toBe(409);
    expect(
      apiError(
        'name_in_use',
        'Name is in use',
        'Use the original queue_key or another name',
      ),
    ).toMatchObject({
      status: 'error',
      code: 'name_in_use',
      retryable: false,
    });
    const [schema] = apiErrors('name_in_use');
    if (schema === undefined) throw new Error('no name_in_use schema');
    expect(statusOf(schema)).toBe(409);
    expect(decodes(schema, errorBody('name_in_use'))).toBe(true);
  });
});
