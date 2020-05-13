import { Worker } from 'worker_threads';
import { resolve as pathResolve } from 'path';
import { Intents } from '../util/Intents';
import {
	GatewayStatus,
	InternalActions,
	MasterWorkerMessages,
	SendPayload,
	SessionDetails,
	WebSocketManagerEvents,
	WorkerMasterMessages
} from '../types/InternalWebSocket';

import type { WebSocketManager } from './WebSocketManager';

const WORKER_PATH = pathResolve(__dirname, 'Worker.js');

export const enum WebSocketShardStatus {
	Disconnected = 'DISCONNECTED',
	Connecting = 'CONNECTING',
	Connected = 'CONNECTED',
	Resuming = 'RESUMING',
	Reconnecting = 'RECONNECTING'
}

/**
 * The Structure to manage a Websocket Worker with
 */
export class WebSocketShard {

	/**
	 * The shards ping (updated every heartbeat ack)
	 */
	public ping = -1;

	/**
	 * The Websocket Connection worker
	 */
	private workerThread: Worker | null;

	/**
	 * Internal Connection status tracker
	 */
	#status: WebSocketShardStatus;

	/**
	 * If this shard is destroyed and should not attempt to reconnect
	*/
	#destroyed: boolean;

	public constructor(public readonly manager: WebSocketManager, public readonly id: number, private readonly totalShards: number, private readonly gatewayURL: string) {
		this.workerThread = null;
		this.#status = WebSocketShardStatus.Disconnected;
		this.#destroyed = false;
	}

	/**
	 * The status of the underlying websocket connection
	 */
	public get status(): WebSocketShardStatus {
		return this.#status;
	}

	/**
	 * Connects the shard to the api
	 * @param token The token for connecting to the websocket
	 */
	public connect(token: string): Promise<GatewayStatus> {
		if (!this.workerThread) {
			this.workerThread = new Worker(WORKER_PATH, {
				workerData: {
					gatewayURL: this.gatewayURL,
					gatewayVersion: this.manager.options.gatewayVersion,
					token,
					options: {
						...this.manager.options.additionalOptions,
						intents: new Intents(this.manager.options.intents).bitfield,
						shard: [this.id, this.totalShards]
					}
				}
			})
				.on('online', this._onWorkerOnline.bind(this))
				.on('message', this._onWorkerMessage.bind(this))
				.on('error', this._onWorkerError.bind(this))
				.on('exit', this._onWorkerExit.bind(this));
		} else {
			this.dispatch({ type: InternalActions.Identify });
		}

		return new Promise((resolve, reject) => {
			const listener = (message: WorkerMasterMessages): void => {
				if (message.type === InternalActions.GatewayStatus) {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					this.workerThread!.off('message', listener);
					resolve(message.data);
				} else if (message.type === InternalActions.CannotReconnect) {
					reject(new Error(`WebSocket closed with code ${message.data.code}: ${message.data.reason}`));
					// Destroy the shard
					this.destroy();
					// Close the worker thread manually
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					this.workerThread!.terminate();
					this.workerThread = null;
				}
			};

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.workerThread!.on('message', listener);
		});
	}

	/**
	 * Gracefully destroys the websocket connection of the underlying thread
	 */
	public destroy(): void {
		this.#destroyed = true;
		this.dispatch({ type: InternalActions.Destroy });
	}

	/**
	 * Sends a Discord payload to the shard.
	 * @param payload The Discord payload to send to this shard
	 */
	public send(payload: SendPayload): void {
		this.dispatch({ type: InternalActions.PayloadDispatch, data: payload });
	}

	/**
	 * Asks the shard to attempt a reconnect
	 */
	public restart(): void {
		if (this.workerThread) this.dispatch({ type: InternalActions.Reconnect });
		else this.manager.scheduleShardRestart(this);
	}

	/**
	 * Fetches the shards session details
	 */
	public fetchSessionData(): Promise<SessionDetails> {
		return new Promise(resolve => {
			const listener = (message: WorkerMasterMessages): void => {
				if (message.type === InternalActions.FetchSessionData) {
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					this.workerThread!.off('message', listener);
					resolve(message.data);
				}
			};

			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			this.workerThread!.on('message', listener);
			this.dispatch({ type: InternalActions.FetchSessionData });
		});
	}

	/**
	 * Sends a message to the websocket connection thread
	 * @param data The data to send
	 */
	private dispatch(data: MasterWorkerMessages): void {
		if (this.workerThread) this.workerThread.postMessage(data);
	}

	/**
	 * Handles logging when the worker thread is online
	 */
	private _onWorkerOnline(): void {
		this.manager.emit(WebSocketManagerEvents.Debug, `[Shard ${this.id}/${this.totalShards}] Worker Thread Online`);
	}

	/**
	 * Handles emitting raw websocket messages with the addition of shard_id
	 * @param packet Raw websocket data packets
	 */
	private _onWorkerMessage(packet: WorkerMasterMessages): void {
		switch (packet.type) {
			case InternalActions.Debug: {
				this.manager.emit(WebSocketManagerEvents.Debug, `[Shard ${this.id}/${this.totalShards}] ${packet.data}`);
				break;
			}
			case InternalActions.UpdatePing: {
				this.ping = packet.data;
				break;
			}
			case InternalActions.ScheduleIdentify: {
				this.manager.scheduleIdentify(this);
				break;
			}
			case InternalActions.Dispatch: {
				// eslint-disable-next-line @typescript-eslint/camelcase
				packet.data.shard_id = this.id;
				this.manager.emit(packet.data.t, packet.data);
				break;
			}
			case InternalActions.ConnectionStatusUpdate: {
				this.#status = packet.data;
				this.manager.emit(WebSocketManagerEvents.Debug, `[Shard ${this.id}/${this.totalShards}] Shard Status Update: ${packet.data}`);
				break;
			}
		}
	}

	/**
	 * Handles logging when the worker thread encounters an error
	 * @param error The error that was encountered
	 */
	private _onWorkerError(error: Error): void {
		this.manager.emit(WebSocketManagerEvents.Debug, `[Shard ${this.id}/${this.totalShards}] ${error.stack}`);
		this.manager.emit(WebSocketManagerEvents.Error, error);
	}

	/**
	 * Handles logging and reconnecting a worker thread when it exits
	 * @param exitCode The exit code
	 */
	private _onWorkerExit(exitCode: number): void {
		this.manager.emit(WebSocketManagerEvents.Debug, `[Shard ${this.id}/${this.totalShards}] Worker Thread Exit[${exitCode}]`);
		this.workerThread = null;
		if (!this.#destroyed) this.manager.scheduleShardRestart(this);
	}

}
