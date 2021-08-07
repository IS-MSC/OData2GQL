import { RESTDataSource } from "apollo-datasource-rest";
import fetch from "node-fetch";

export const createDataSource = (url: string) => {
	return class ODataAPI extends RESTDataSource {
		constructor() {
			super();
			this.baseURL = url;
		}

		cache: { [url: string]: any } = {};
		counter = 0;

		request = async (url: string) => {
			if (this.cache[url]) {
				return this.cache[url];
			}
			const response = await fetch(url).then((r) => r.json());
			console.log(this.counter++);
			if (!response.d) {
				this.cache[url] = null;
				return null;
			}
			if (!!response.d.results) {
				this.cache[url] = response.d.results;
			} else {
				this.cache[url] = response.d;
			}

			return this.cache[url];
		};
	};
};
