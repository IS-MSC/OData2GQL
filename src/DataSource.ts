import { RESTDataSource } from "apollo-datasource-rest";
import { response } from "express";
import fetch from "node-fetch";
import { batchFetch, Method } from "./BatchFetch";

interface PendingRequest {
	resolve: (data: any) => void;
	reject: (e: any) => void;
	url: string;
	status: "pending" | "fresh" | "fullfiled";
}

let count = 0;
const typeSizes = {
	undefined: () => 0,
	boolean: () => 4,
	number: () => 8,
	string: (item: any) => 2 * item.length,
	object: (item: any): any =>
		!item
			? 0
			: Object.keys(item).reduce(
					(total, key) =>
						sizeOf(key as keyof typeof typeSizes) + sizeOf(item[key]) + total,
					0
			  ),
};

//@ts-ignore
const sizeOf = (value: keyof typeof typeSizes) =>
	//@ts-ignore
	typeSizes[typeof value](value);

const IntervalHolder = (() => {
	const subscribers: WeakRef<
		InstanceType<ReturnType<typeof createDataSource>>
	>[] = [];

	const interval = setInterval(() => {
		console.log(
			subscribers.reduce((a, s) => {
				if (s.deref()) {
					return a + 1;
				}
				return a;
			}, 0)
		);
		subscribers.forEach((s) => {
			const subscriber = s.deref();
			if (subscriber) {
				const urls = Object.entries(subscriber.requestMap)
					.filter(([url, request]) => request.status == "fresh")
					.slice(0, 20)
					.map(([url, request]) => {
						subscriber.requestMap[url].status = "pending";
						count++;
						if (count > 100) {
							process.exit(-1);
						}
						return {
							method: Method.GET,
							url: url,
							request: request,
						};
					});
				if (urls.length) {
					console.log("Packing together " + urls.length + " requests ");
					batchFetch({
						url: subscriber.baseURL!,
						data: urls,
					}).then(([status, data]) => {
						console.log(Math.round(sizeOf(data) / 1024) + "KB");
						urls.forEach((r, i) => {
							let results = data[i].data.d;
							if (results && results.results) {
								results = results.results;
							}

							r.request.resolve(results);
						});
					});
				}
			}
		});
	});

	return {
		subscribe: (api: InstanceType<ReturnType<typeof createDataSource>>) => {
			subscribers.push(new WeakRef(api));
		},
	};
})();

export const createDataSource = (url: string) => {
	return class ODataAPI extends RESTDataSource {
		constructor() {
			super();
			this.baseURL = url;

			IntervalHolder.subscribe(this);
		}

		public requestMap: { [url: string]: PendingRequest } = {};
		cache: { [url: string]: any } = {};
		promiseMap: Promise<any>[] = [];
		id = 0;
		_fetch(url: string) {
			let promise = new Promise((resolve, reject) => {
				if (this.requestMap[url]) {
					const existingRequest = { ...this.requestMap[url] };

					if (existingRequest.status != "fullfiled") {
						const oldResolve = existingRequest.resolve;
						existingRequest.resolve = (data: any) => {
							oldResolve(data);
							resolve(data);
						};
						const oldReject = existingRequest.reject;
						existingRequest.reject = (e: any) => {
							oldReject(e);
							reject(e);
						};
						this.requestMap[url] = existingRequest;
					} else {
						resolve(this.cache[url]);
					}
				} else {
					this.requestMap[url] = {
						url,
						reject: (e: any) => {
							reject(e);
							this.cache[url] = e;
							this.requestMap[url].status = "fullfiled";
						},
						resolve: (data: any) => {
							resolve(data);
							this.cache[url] = data;
							this.requestMap[url].status = "fullfiled";
						},
						status: "fresh",
					};
				}
			});
			return promise;
		}
		requestCounter = 0;

		request = async (url: string) => {
			this.requestCounter++;
			try {
				this.requestCounter--;
				const response = await this._fetch(url);

				return response;
			} catch (e) {
				this.requestCounter--;

				return null;
			}
		};
	};
};
