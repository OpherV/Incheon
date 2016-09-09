"use strict";

const SyncStrategy = require("./SyncStrategy");

const defaults = {
    syncsBufferLength: 5,
    RTTEstimate: 2,       // estimate the RTT as two steps (for updateRate=6, that's 200ms)
    extrapolate: 2,       // player performs method "X" which means extrapolate to match server time. that 100 + (0..100)
    localObjBending: 0.1, // amount of bending towards position of sync object
    remoteObjBending: 0.6 // amount of bending towards position of sync object
};

class ExtrapolateStrategy extends SyncStrategy {

    constructor(clientEngine, inputOptions) {

        const options = Object.assign({}, defaults, inputOptions);
        super(clientEngine, options);

        this.newSync = null;
        this.recentInputs = {};
        this.gameEngine = this.clientEngine.gameEngine;
        this.gameEngine.on('postStep', this.extrapolate.bind(this));
        this.gameEngine.on('client.syncReceived', this.collectSync.bind(this));
        this.gameEngine.on('client.preInput', this.clientInputSave.bind(this));
    }

    // keep a buffer of inputs so that we can replay them on extrapolation
    clientInputSave(inputData) {

        // if no inputs have been stored for this step, create an array
        if (!this.recentInputs[inputData.step]) {
            this.recentInputs[inputData.step] = [];
        }
        this.recentInputs[inputData.step].push(inputData);
    }

    // collect a sync and its events
    collectSync(e) {
        // TODO avoid editing the input event

        // keep a reference of events by object id
        e.syncObjects = {};
        e.syncEvents.forEach(sEvent => {
            let o = sEvent.objectInstance;
            if (!e.syncObjects[o.id]) {
                e.syncObjects[o.id] = [];
            }
            e.syncObjects[o.id].push(sEvent);
        });

        // keep a reference of events by step
        e.syncSteps = {};
        e.syncEvents.forEach(sEvent => {

            // add an entry for this step and event-name
            if (!e.syncSteps[sEvent.stepCount]) e.syncSteps[sEvent.stepCount] = {};
            if (!e.syncSteps[sEvent.stepCount][sEvent.eventName]) e.syncSteps[sEvent.stepCount][sEvent.eventName] = [];
            e.syncSteps[sEvent.stepCount][sEvent.eventName].push(sEvent);
        });

        // remember this sync
        this.newSync = e;
    }

    // add an object to our world
    addNewObject(objId, newObj) {

        let curObj = newObj.class.newFrom(newObj);
        this.gameEngine.addObjectToWorld(curObj);
        console.log(`adding new object ${curObj}`);

        // if this game keeps a physics engine on the client side,
        // we need to update it as well
        // TODO: why not have this call inside (gameEngine.addObjectToWorld() above?)
        if (this.gameEngine.physicsEngine && curObj.hasOwnProperty('initPhysicsObject')) {
            curObj.initPhysicsObject(this.gameEngine.physicsEngine);
        }

        return curObj;
    }

    // clean up the input buffer
    cleanRecentInputs() {
        let firstReplayStep = this.gameEngine.world.stepCount - this.options.extrapolate;
        for (let input of Object.keys(this.recentInputs)) {
            if (this.recentInputs[input].step < firstReplayStep) {
                delete this.recentInputs[input];
            }
        }
    }

    // apply a new sync
    applySync() {
        if (!this.newSync) {
            return;
        }

        this.gameEngine.trace.debug('extrapolate applying sync');

        //
        //    scan all the objects in the sync
        //
        // 1. if the object has a local shadow, adopt the server object,
        //    and destroy the shadow
        //
        // 2. if the object exists locally, sync to the server object,
        //    later we will re-enact the missing steps and then bend to
        //    the current position
        //
        // 3. if the object is new, just create it
        //
        let world = this.gameEngine.world;
        let serverStep = -1;
        for (let ids of Object.keys(this.newSync.syncObjects)) {
            this.newSync.syncObjects[ids].forEach(ev => {
                let curObj = world.objects[ev.objectInstance.id];
                serverStep = Math.max(serverStep, ev.stepCount);

                let localShadowObj = this.gameEngine.findLocalShadow(ev.objectInstance);
                if (localShadowObj) {

                    // case 1: this object as a local shadow object on the client
                    this.gameEngine.trace.debug(`object ${ev.objectInstance.id} replacing local shadow ${localShadowObj.id}`);
                    let newObj = this.addNewObject(ev.objectInstance.id, ev.objectInstance);
                    newObj.saveState(localShadowObj);
                    localShadowObj.destroy();
                    delete this.gameEngine.world.objects[localShadowObj.id];

                } else if (curObj) {

                    // case 2: this object already exists locally
                    this.gameEngine.trace.trace(`object before syncTo: ${curObj.toString()}`);
                    curObj.saveState();
                    curObj.syncTo(ev.objectInstance);
                    this.gameEngine.trace.trace(`object after syncTo: ${curObj.toString()} synced to step[${ev.stepCount}]`);

                } else {

                    // case 3: object does not exist.  create it now
                    this.addNewObject(ev.objectInstance.id, ev.objectInstance);
                }
            });
        }

        //
        // re-enact the steps that we want to extrapolate forwards
        //
        this.cleanRecentInputs();
        this.gameEngine.trace.debug(`extrapolate re-enacting steps from [${serverStep}] to [${world.stepCount}]`);
        this.gameEngine.serverStep = serverStep;
        for (; serverStep < world.stepCount; serverStep++) {
            if (this.recentInputs[serverStep]) {
                this.recentInputs[serverStep].forEach(inputData => {

                    // only movement inputs are re-enacted
                    if (!inputData.inputOptions || !inputData.inputOptions.movement) return;

                    this.gameEngine.trace.trace(`extrapolate re-enacting movement input[${inputData.messageIndex}]: ${inputData.input}`);
                    this.gameEngine.processInput(inputData, this.clientEngine.playerId);
                });
            }

            for (let objId of Object.keys(world.objects)) {

                // shadow objects are not re-enacted
                if (objId >= this.gameEngine.options.clientIDSpace)
                    continue;

                world.objects[objId].step(this.gameEngine.worldSettings);
                this.gameEngine.trace.trace(`extrapolate re-enacting step[${serverStep}] on obj[${objId}]`);
            }
        }

        //
        // bend back to original state
        //
        for (let objId of Object.keys(world.objects)) {

            // shadow objects are not bent
            if (objId >= this.gameEngine.options.clientIDSpace)
                continue;

            let obj = world.objects[objId];
            // TODO: using == instead of === because of string/number mismatch
            let bending = (objId == this.clientEngine.playerId) ? this.options.localObjBending : this.options.remoteObjBending;
            obj.bendToSavedState(bending, this.gameEngine.worldSettings);
            this.gameEngine.trace.trace(`object[${objId}] bending=${bending} values (dx, dy, dphi) = (${obj.bendingX},${obj.bendingY},${obj.bendingAngle})`);
        }

        // trace object state after sync
        for (let objId of Object.keys(world.objects)) {
            this.gameEngine.trace.trace(`object after extrapolate replay: ${world.objects[objId].toString()}`);
        }

        // destroy uneeded objects
        // TODO: use this.forEachSyncObject instead of for-loop
        //       you will need to loop over prevObj instead of nextObj
        for (let objId of Object.keys(world.objects)) {
            if (objId < this.gameEngine.options.clientIDSpace && !this.newSync.syncObjects.hasOwnProperty(objId)) {
                world.objects[objId].destroy();
                delete this.gameEngine.world.objects[objId];
            }
        }

        this.newSync = null;
    }

    // Perform client-side extrapolation.
    extrapolate() {

        // if there is a sync from the server, apply it now
        this.applySync();
    }
}

module.exports = ExtrapolateStrategy;
