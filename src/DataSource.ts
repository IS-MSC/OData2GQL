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

export const createDataSource = (url: string) => {
	return class ODataAPI extends RESTDataSource {
		constructor() {
			super();
			this.baseURL = url;

			setInterval(() => {
				// console.log("Request map", this.requestMap);
				const urls = Object.entries(this.requestMap)
					.filter(([url, request]) => request.status == "fresh")
					.map(([url, request]) => {
						this.requestMap[url].status = "pending";
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
					batchFetch({
						url: this.baseURL!,
						data: urls,
					}).then(([status, data]) =>
						urls.forEach((r, i) => {
							let results = data[i].data.d;
							if (results && results.results) {
								results = results;
							}
							r.request.resolve(results);
						})
					);
				}
			});
		}

		requestMap: { [url: string]: PendingRequest } = {};
		cache: { [url: string]: any } = {};
		promiseMap: Promise<any>[] = [];

		_fetch(url: string) {
			let promise = new Promise((resolve, reject) => {
				if (this.requestMap[url]) {
					const existingRequest = this.requestMap[url];

					if (existingRequest.status != "fullfiled") {
						existingRequest.resolve = (data: any) => {
							this.requestMap[url].resolve(data);
							resolve(data);
						};
						existingRequest.reject = (e: any) => {
							this.requestMap[url].reject(e);
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
