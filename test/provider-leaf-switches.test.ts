import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePeachifyLeaves } from '../src/providers/peachify/peachify.config.js';
import {
    createEzVidApiLeafPolicy,
    EZVIDAPI_LEAVES
} from '../src/providers/ezvidapi/ezvidapi.config.js';
import {
    createPoprLeafPolicy,
    POPR_LEAVES
} from '../src/providers/popr/popr.config.js';
import {
    GLOBAL_LEAF_ALLOW_ENV,
    GLOBAL_LEAF_DENY_ENV,
    globalLeafSwitch
} from '../src/providers/provider-leaf-switches.js';
import { createTulnexLeafPolicy } from '../src/providers/tulnex/tulnex.config.js';
import { resolveVideasyServers } from '../src/providers/videasy/videasy.config.js';
import {
    createVidnestLeafPolicy,
    VIDNEST_ELIGIBLE_LEAVES
} from '../src/providers/vidnest/vidnest.config.js';

test('global denies reach every implemented aggregator without cross-family bleed', () => {
    const environment = {
        [GLOBAL_LEAF_DENY_ENV]:
            'tulnex:onion,videasy:cdn,popr:gama,vidnest:onehd,peachify:air'
    };
    assert.equal(
        createTulnexLeafPolicy(environment).enabledLeaves.has('onion'),
        false
    );
    assert.equal(
        resolveVideasyServers(environment).some(({ name }) => name === 'cdn'),
        false
    );
    assert.equal(
        createPoprLeafPolicy(environment).enabled(
            POPR_LEAVES.find(({ id }) => id === 'popr:gama')!
        ),
        false
    );
    assert.equal(createVidnestLeafPolicy(environment).enabled('onehd'), false);
    assert.equal(
        resolvePeachifyLeaves(environment).some(({ name }) => name === 'air'),
        false
    );
    assert.equal(
        createEzVidApiLeafPolicy(environment).enabled(
            EZVIDAPI_LEAVES.find(({ slug }) => slug === 'vidsrc')!
        ),
        true
    );
});

test('a present global allowlist is an actual allowlist for each family', () => {
    const environment = {
        [GLOBAL_LEAF_ALLOW_ENV]:
            'tulnex:onion,videasy:cdn,popr:gama,vidnest:onehd'
    };
    assert.deepEqual(
        [...createTulnexLeafPolicy(environment).enabledLeaves],
        ['onion']
    );
    assert.deepEqual(
        resolveVideasyServers(environment).map(({ name }) => name),
        ['cdn']
    );
    assert.deepEqual(
        POPR_LEAVES.filter(createPoprLeafPolicy(environment).enabled).map(
            ({ id }) => id
        ),
        ['popr:gama']
    );
    assert.deepEqual(
        VIDNEST_ELIGIBLE_LEAVES.filter(
            createVidnestLeafPolicy(environment).enabled
        ),
        ['onehd']
    );
    assert.deepEqual(resolvePeachifyLeaves(environment), []);
    assert.deepEqual(
        EZVIDAPI_LEAVES.filter(createEzVidApiLeafPolicy(environment).enabled),
        []
    );
});

test('local and global allows intersect and both deny lists win', () => {
    const policy = createTulnexLeafPolicy({
        TULNEX_LEAF_ALLOWLIST: 'onion,icefy',
        TULNEX_LEAF_DENYLIST: 'icefy',
        [GLOBAL_LEAF_ALLOW_ENV]: 'tulnex:onion,tulnex:icefy',
        [GLOBAL_LEAF_DENY_ENV]: 'tulnex:onion'
    });
    assert.deepEqual([...policy.enabledLeaves], []);
});

test('global switch syntax and duplicates fail without echoing raw values', () => {
    const secret = 'https://private.invalid/?token=do-not-log';
    assert.throws(
        () =>
            globalLeafSwitch(
                { [GLOBAL_LEAF_DENY_ENV]: secret },
                'tulnex',
                'deny'
            ),
        (error: Error) => !error.message.includes(secret)
    );
    assert.throws(
        () =>
            globalLeafSwitch(
                {
                    [GLOBAL_LEAF_ALLOW_ENV]: 'tulnex:onion,tulnex:onion'
                },
                'tulnex',
                'allow'
            ),
        /duplicate/
    );
});
