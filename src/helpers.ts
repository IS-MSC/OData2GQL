import {
	GraphQLString,
	GraphQLBoolean,
	GraphQLInt,
	GraphQLFloat,
} from "graphql";
import { Schema } from "./index";
import fs from "fs";

export const castTypesToGQL = (type: string) => {
	switch (type) {
		case "String":
			return GraphQLString;
		case "Boolean":
			return GraphQLBoolean;
		case "Int32":
		case "Int16":
			return GraphQLInt;
		case "Decimal":
			return GraphQLFloat;
		default:
			console.log(type);
			return GraphQLString;
	}
};

export const saveSchema = (schema: Schema) => {
	fs.writeFile("./data/data.json", JSON.stringify(schema), () => {
		// console.log("Done!");
	});
};

export const capitalize = (s: string) => s && s[0].toUpperCase() + s.slice(1);

export const toArray = <T>(value: T | T[]): T[] => {
	return Array.isArray(value) ? value : [value];
};
