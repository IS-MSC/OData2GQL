import parser from "xml-js";
import fetct from "node-fetch";
import fs from "fs";
import {
	graphql,
	GraphQLBoolean,
	GraphQLField,
	GraphQLFloat,
	GraphQLID,
	GraphQLInt,
	GraphQLList,
	GraphQLObjectType,
	GraphQLSchema,
	GraphQLString,
	printSchema,
} from "graphql";
import { castTypesToGQL, saveMetadata } from "./helpers";
import express from "express";
import { graphqlHTTP } from "express-graphql";
import { ApolloServer } from "apollo-server-express";
import console from "console";
import merge from "lodash.merge";
const serviceURL =
	"http://192.168.1.176:8080/sap/opu/odata/sap/ZPM_DL_MAIN_SRV";

const capitalize = (s: string) => s && s[0].toUpperCase() + s.slice(1);

const getMetadata = async () => {
	const metadata = await fetct(serviceURL + "/$metadata").then((response) =>
		response.text()
	);
	return metadata;
};

const getSchema = async () => {
	const metadata = parser.xml2js(await getMetadata(), {
		compact: true,
		ignoreDeclaration: true,
		// ignoreAttributes: true,
		elementNameFn: function (val) {
			return val.replace("edmx:", "");
		},
		attributeValueFn: (v) => {
			let tmp = v;
			if (v.includes("Edm.")) {
				tmp = v.replace("Edm.", "");
			}
			return tmp;
		},
		attributeNameFn: (v) => {
			let tmp = v;
			if (v.includes("sap:")) {
				tmp = v.replace("sap:", "");
			}
			return capitalize(tmp);
		},
	}) as any;
	const schema = metadata["Edmx"]["DataServices"]["Schema"] as Schema;
	return schema;
};

const main = async () => {
	const schema = await getSchema();
	saveMetadata(schema);

	const associations = schema.Association.map(makeAssociation);
	console.log(associations);
	const entities = schema.EntityType.map(makeEntity);
	const gqlQueries = entities.map(makeGQLQuery);
	gqlQueries.forEach((q) => {
		fs.writeFile(
			`./data/gql/${q.name}.gql`,
			printSchema(
				new GraphQLSchema({
					query: q.query,
				})
			),
			() => {
				// console.log("Done!");
			}
		);
	});
	const globalSchema = new GraphQLSchema({
		query: makeGlobalQuery(),
	});
	fs.writeFile(`./data/gql/${"global"}.gql`, printSchema(globalSchema), () => {
		// console.log("Done!");
	});
	var app = express();
	const server = new ApolloServer({
		schema: globalSchema,
	});
	await server.start();
	server.applyMiddleware({ app });

	app.listen({ port: 4000 }, () => {
		console.log("Server is ready at loсalhost:4000" + server.graphqlPath);
	});
	// console.log(entities);
};

const makeNavigationResolver = (
	entity: Entity,
	field: string,
	isSet: boolean
) => {
	const resolver = async (parent: any, params: any) => {
		const query = entity.keys
			.map((key) => {
				console.log(key, parent);
				return `${key}='${parent[key]}'`;
			})
			.join(",");
		const url = `${serviceURL}/${entity.name}Set(${query})/${field}?$format=json`;
		console.log(url);
		const response = await fetct(url).then((r) => r.json());
		console.log(response);
		if (isSet) {
			return response.d.results;
		}
		return response.d;
	};
	return resolver;
};

const makeFieldMap = (entity: Entity) => {
	return () => {
		const PropertiesFields = entity.properties.reduce((a, p) => {
			a[p.name] = {
				type: p.name.includes("Id") ? GraphQLID : castTypesToGQL(p.type),
			};
			if (p.name.includes("Id")) {
				const name = p.name.replace("Id", "");
				if (name !== entity.name && EntityMap[name]) {
					a[name] = {
						type: EntityMap[name].gqlType,
						resolve: makeParentResolver(EntityMap[name].entity),
					};
				}
			}
			return a;
		}, {} as { [index: string]: any });
		const NavigationFields = entity.navigation.reduce((a, n) => {
			const gqlType = EntityMap[n.type].gqlType;
			if (!gqlType) {
				return a;
			}
			a[n.name] = {
				type: n.isSet ? new GraphQLList(gqlType) : gqlType,
				resolve: makeNavigationResolver(entity, n.name, n.isSet),
			};
			return a;
		}, {} as { [index: string]: any });
		const Metadata = metaDataField;

		return merge(NavigationFields, PropertiesFields, Metadata);
	};
};

const makeMetadataField = () => {
	return {
		_metadata: {
			type: new GraphQLObjectType({
				name: "Metadata",
				fields: {
					id: {
						type: GraphQLString,
					},
					uri: {
						type: GraphQLString,
					},
					media_src: {
						type: GraphQLString,
					},
					edit_media: {
						type: GraphQLString,
					},
				},
			}),
			resolve: (parent: any) => {
				return parent.__metadata;
			},
		},
	};
};

const metaDataField = makeMetadataField();

const makeGQLType = (entity: Entity) => {
	const type = new GraphQLObjectType({
		name: entity.name,
		fields: makeFieldMap(entity),
		description: entity.description,
	});
	return type;
};
const makeKeysResolver = (entity: Entity) => {
	const resolver = async (_: any, params: any) => {
		const query = entity.keys
			.map((key) => {
				return `${key}='${params[key]}'`;
			})
			.join(",");
		const response = await fetct(
			`${serviceURL}/${entity.name}Set(${query})?$format=json`
		).then((r) => r.json());
		console.log(response);
		return response.d;
	};
	return resolver;
};

const makeParentResolver = (entity: Entity) => {
	const resolver = async (parent: any, params: any) => {
		const query = entity.keys
			.map((key) => {
				return `${key}='${parent[key]}'`;
			})
			.join(",");
		const response = await fetct(
			`${serviceURL}/${entity.name}Set(${query})?$format=json`
		).then((r) => r.json());
		console.log(response);
		return response.d;
	};
	return resolver;
};

const makeSetResolver = (entity: Entity) => {
	const resolver = async (_: any, params: any) => {
		const query = [
			params["first"] ? `$top=${params["first"]}` : "",
			params["offset"] ? `$skip=${params["offset"]}` : "",
			params["substring"]
				? `$filter=substringof('${encodeURIComponent(
						params["substring"]
				  )}', DamageName)`
				: "",
		]
			.filter((v) => !!v)
			.join("&");
		const url = `${serviceURL}/${entity.name}Set?$format=json&${query}`;
		console.log(url);
		const response = await fetct(url).then((r) => r.json());
		console.log(response);
		return response.d.results;
	};
	return resolver;
};
const globalQueryFields: { [index: string]: any } = {};
const makeGQLQueryFields = (entity: Entity, type: GraphQLObjectType) => {
	const fields: { [index: string]: any } = {};
	const field = {
		type: type,
		args: entity.keys.reduce((a, k) => {
			a[k] = {
				type: GraphQLID,
			};
			return a;
		}, {} as { [index: string]: any }),
		resolve: makeKeysResolver(entity),
	};
	const setField = {
		type: new GraphQLList(type),
		args: ["first", "offset", "substring"].reduce((a, k) => {
			a[k] = {
				type: k === "substring" ? GraphQLString : GraphQLInt,
			};
			return a;
		}, {} as { [index: string]: any }),
		resolve: makeSetResolver(entity),
	};
	fields[entity.name] = field;
	fields[entity.name + "Set"] = setField;

	globalQueryFields[entity.name] = field;
	globalQueryFields[entity.name + "Set"] = setField;
	return fields;
};
const makeGlobalQuery = () => {
	const query = new GraphQLObjectType({
		name: "Query",
		fields: globalQueryFields,
	});
	return query;
};
const makeGQLQuery = (entity: Entity) => {
	const type = makeGQLType(entity);
	EntityMap[entity.name].gqlType = type;
	const fields = makeGQLQueryFields(entity, type);
	const query = new GraphQLObjectType({
		name: "Query",
		fields: fields,
	});
	return { query, name: entity.name };
};

const toArray = <T>(value: T | T[]): T[] => {
	return Array.isArray(value) ? value : [value];
};

const EntityMap: {
	[name: string]: {
		gqlType?: GraphQLObjectType;
		entity: Entity;
	};
} = {};

const makeEntity = (raw: ODataEntity): Entity => {
	const properties = toArray(raw.Property).map((p) => {
		// console.log(p._attributes.Type);
		return {
			name: p._attributes.Name,
			type: p._attributes.Type,
			nullable: false,
			label: p._attributes.Label || "",
		};
	});

	const keys = toArray(raw.Key.PropertyRef).map((e) => e._attributes.Name);
	const navigation =
		(raw.NavigationProperty &&
			toArray(raw.NavigationProperty).map((n) => {
				const association =
					AssociationMap[
						n._attributes.Relationship.replace("ZPM_DL_MAIN_SRV.", "")
					];
				return {
					name: n._attributes.Name.replace("ZPM_DL_MAIN_SRV.", ""),
					type: association.to,
					isSet: association.isSet,
				};
			})) ||
		[];
	console.log(navigation);
	const entity = {
		name: raw._attributes.Name,
		description: raw._attributes.Label || "",
		properties: properties,
		keys: keys,
		navigation,
	};
	EntityMap[raw._attributes.Name] = {
		entity,
	};
	return entity;
};

const AssociationMap: { [name: string]: Association } = {};
const makeAssociation = (raw: ODataAssociation): Association => {
	const toRaw = raw.End.find((e) =>
		e._attributes.Role.includes("ToRole_")
	)!._attributes;
	const to = toRaw.Type.replace("ZPM_DL_MAIN_SRV.", "");
	const isSet = toRaw.Multiplicity == "*";
	const association = {
		name: raw._attributes.Name,
		to,
		isSet,
	};
	AssociationMap[association.name] = association;
	return association;
};

interface Entity {
	name: string;
	description: string;
	properties: {
		name: string;
		type: string;
		nullable: boolean;

		label: string;
	}[];
	keys: string[];
	navigation: {
		name: string;
		type: string;
		isSet: boolean;
	}[];
}

interface Association {
	name: string;
	to: string;
	isSet: boolean;
}

interface ODataProperty {
	_attributes: {
		Name: string;

		Type: string;
		Nullable: boolean;
		MaxLength?: number;
		Label?: string;
	};
}
interface ODataEntity {
	_attributes: {
		Name: string;
		Label?: string;
	};
	Key: {
		PropertyRef:
			| { _attributes: { Name: string } }[]
			| { _attributes: { Name: string } };
	};
	Property: ODataProperty[] | ODataProperty;
	NavigationProperty?:
		| {
				_attributes: {
					Name: string;
					Relationship: string;
					FromRole: string;
					ToRole: string;
				};
		  }
		| {
				_attributes: {
					Name: string;
					Relationship: string;
					FromRole: string;
					ToRole: string;
				};
		  }[];
}

interface ODataAssociation {
	_attributes: {
		Name: string;
	};
	End: {
		_attributes: {
			Type: string;
			Multiplicity: "1" | "*";
			Role: string;
		};
	}[];
	ReferentialConstraint: {
		Principal: {
			_attributes: { Role: string };
			PropertyRef: { _attributes: { Name: string } };
		};
		Dependent: {
			_attributes: { Role: string };
			PropertyRef: { _attributes: { Name: string } };
		};
	};
}

export interface Schema {
	EntityType: ODataEntity[];
	Association: ODataAssociation[];
}
main();
