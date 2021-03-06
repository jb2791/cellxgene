import _ from "lodash";
import * as globals from "../globals";
import { Universe, MatrixFBS } from "../util/stateManager";
import * as Dataframe from "../util/dataframe";
import {
  catchErrorsWrap,
  doJsonRequest,
  doBinaryRequest,
  dispatchNetworkErrorMessageToUser
} from "../util/actionHelpers";
import { PromiseLimit } from "../util/promiseLimit";
import { requestReembed, reembedResetWorldToUniverse } from "./reembed";

/*
return promise to fetch the OBS annotations we need to load.  Omit anything
we don't need.
*/
function obsAnnotationFetchAndLoad(dispatch, schema) {
  const obsAnnotations = schema?.schema?.annotations?.obs ?? {};
  const index = obsAnnotations.index ?? false;
  const columns = (obsAnnotations.columns ?? []).filter(
    col => col.name !== index
  );

  const plimit = new PromiseLimit(4);
  return Promise.all(
    columns.map(col =>
      plimit.add(() => {
        const path = `annotations/obs?annotation-name=${encodeURIComponent(
          col.name
        )}`;
        const url = `${globals.API.prefix}${globals.API.version}${path}`;
        return doBinaryRequest(url).then(buffer => {
          const df = Universe.matrixFBSToDataframe(buffer);
          dispatch({
            type: "universe: column load success",
            dim: "obsAnnotations",
            dataframe: df
          });
        });
      })
    )
  );
}

/*
return promise fetching VAR annotations we need to load.  Only index is currently used.
*/
function varAnnotationFetchAndLoad(dispatch, schema) {
  const varAnnotations = schema?.schema?.annotations?.var ?? {};
  const index = varAnnotations.index ?? false;
  const names = index ? [index] : [];
  return Promise.all(
    names
      .map(name => {
        const path = `annotations/var?annotation-name=${encodeURIComponent(
          name
        )}`;
        const url = `${globals.API.prefix}${globals.API.version}${path}`;
        return doBinaryRequest(url);
      })
      .map(rqst => rqst.then(buffer => Universe.matrixFBSToDataframe(buffer)))
      .map(resp =>
        resp.then(df =>
          dispatch({
            type: "universe: column load success",
            dim: "varAnnotations",
            dataframe: df
          })
        )
      )
  );
}

/*
return promise fetching layout we need
*/
function layoutFetchAndLoad(dispatch, schema) {
  const embeddings = schema?.schema?.layout?.obs ?? [];
  const embNames = embeddings.map(e => e.name);
  const baseURL = `${globals.API.prefix}${globals.API.version}layout/obs`;

  const plimit = new PromiseLimit(4);
  return Promise.all(
    embNames.map(e =>
      plimit.add(() => {
        const url = `${baseURL}?layout-name=${encodeURIComponent(e)}`;
        return doBinaryRequest(url).then(buffer =>
          Universe.matrixFBSToDataframe(buffer)
        );
      })
    )
  ).then(dfs => {
    const df = Dataframe.Dataframe.empty().withColsFromAll(dfs);
    dispatch({
      type: "universe: column load success",
      dim: "obsLayout",
      dataframe: df
    });
  });
}

/*
Bootstrap application with the initial data loading.
  * /config - application configuration
  * /schema - schema of dataframe
  * /annotations - all metadata annotation
  * /layout - all default layout
*/
const doInitialDataLoad = () =>
  catchErrorsWrap(async dispatch => {
    dispatch({ type: "initial data load start" });

    try {
      /*
      Step 1 - config & schema, all JSON
      */
      const requestJson = ["config", "schema"]
        .map(r => `${globals.API.prefix}${globals.API.version}${r}`)
        .map(url => doJsonRequest(url));
      const stepOneResults = await Promise.all(requestJson);
      /* set config defaults */
      const config = { ...globals.configDefaults, ...stepOneResults[0].config };
      const schema = stepOneResults[1];
      const universe = Universe.createUniverseFromResponse(config, schema);
      dispatch({
        type: "universe exists, but loading is still in progress",
        universe
      });
      dispatch({
        type: "configuration load complete",
        config
      });

      /*
      Step 2 - load the minimum stuff required to display.
      */
      await Promise.all([
        layoutFetchAndLoad(dispatch, schema),
        varAnnotationFetchAndLoad(dispatch, schema)
      ]);

      /*
      Step 3 - load everything else
      */
      await obsAnnotationFetchAndLoad(dispatch, schema);

      dispatch({
        type: "initial data load complete (universe exists)",
        universe
      });
    } catch (error) {
      dispatch({ type: "initial data load error", error });
    }
  }, true);

/*
Set the view (world) to current selection.   Placeholder for an async action
which also does re-layout.
*/
const setWorldToSelection = () => (dispatch, getState) => {
  const { universe, world, crossfilter } = getState();
  dispatch({
    type: "set World to current selection",
    universe,
    world,
    crossfilter
  });
};

// Throws
const dispatchExpressionErrors = (dispatch, res) => {
  const msg = `Unexpected HTTP response while fetching expression data ${res.status}, ${res.statusText}`;
  dispatchNetworkErrorMessageToUser(msg);
  throw new Error(msg);
};

/*
Fetch expression vectors for each gene in genes.  This is NOT an action
function, but rather a helper to be called from an action helper that
needs expression data.

Transparently utilizes cached data if it is already present.
*/
async function _doRequestExpressionData(dispatch, getState, genes) {
  const state = getState();
  const { universe } = state;
  const varIndexName = universe.schema.annotations.var.index;

  /* helper for this function only */
  const fetchData = async geneNames => {
    const res = await fetch(
      `${globals.API.prefix}${globals.API.version}data/var`,
      {
        method: "PUT",
        body: JSON.stringify({
          filter: {
            var: {
              annotation_value: [{ name: varIndexName, values: geneNames }]
            }
          }
        }),
        headers: new Headers({
          accept: "application/octet-stream",
          "Content-Type": "application/json"
        }),
        credentials: "include"
      }
    );

    if (
      !res.ok ||
      res.headers.get("Content-Type") !== "application/octet-stream"
    ) {
      // WILL throw
      return dispatchExpressionErrors(dispatch, res);
    }

    const data = await res.arrayBuffer();
    return Universe.convertDataFBStoObject(universe, data);
  };

  /* preload data already in cache */
  let expressionData = _.transform(
    genes,
    (expData, g) => {
      const data = universe.varData.col(g);
      if (data) {
        expData[g] = data.asArray();
      }
    },
    {}
  ); // --> { gene: data }
  /* make a list of genes for which we do not have data */
  const genesToFetch = _.filter(genes, g => expressionData[g] === undefined);

  dispatch({ type: "expression load start" });

  /* Fetch data for any genes not in cache */
  if (genesToFetch.length) {
    try {
      const newExpressionData = await fetchData(genesToFetch);
      expressionData = {
        ...expressionData,
        ...newExpressionData
      };
    } catch (error) {
      dispatch({ type: "expression load error", error });
      throw error; // rethrow
    }
  }

  dispatch({ type: "expression load success", expressionData });
  return expressionData;
}

function requestSingleGeneExpressionCountsForColoringPOST(gene) {
  return async (dispatch, getState) => {
    dispatch({ type: "get single gene expression for coloring started" });
    try {
      await _doRequestExpressionData(dispatch, getState, [gene]);
      const { world } = getState();
      dispatch({
        type: "color by expression",
        gene,
        data: {
          [gene]: world.varData.col(gene).asArray()
        }
      });
    } catch (error) {
      dispatch({
        type: "get single gene expression for coloring error",
        error
      });
    }
  };
}

const requestUserDefinedGene = gene => async (dispatch, getState) => {
  dispatch({ type: "request user defined gene started" });
  try {
    await await _doRequestExpressionData(dispatch, getState, [gene]);
    const { world } = getState();

    /* then send the success case action through */
    return dispatch({
      type: "request user defined gene success",
      data: {
        genes: [gene],
        expression: world.varData.col(gene).asArray()
      }
    });
  } catch (error) {
    return dispatch({
      type: "request user defined gene error",
      error
    });
  }
};

const dispatchDiffExpErrors = (dispatch, response) => {
  switch (response.status) {
    case 403:
      dispatchNetworkErrorMessageToUser(
        "Too many cells selected for differential experesion calculation - please make a smaller selection."
      );
      break;
    case 501:
      dispatchNetworkErrorMessageToUser(
        "Differential expression is not implemented."
      );
      break;
    default: {
      const msg = `Unexpected differential expression HTTP response ${response.status}, ${response.statusText}`;
      dispatchNetworkErrorMessageToUser(msg);
      dispatch({
        type: "request differential expression error",
        error: new Error(msg)
      });
    }
  }
};

const requestDifferentialExpression = (set1, set2, num_genes = 10) => async (
  dispatch,
  getState
) => {
  dispatch({ type: "request differential expression started" });
  try {
    /*
    Steps:
    1. get the most differentially expressed genes
    2. get expression data for each
    */
    const state = getState();
    const { universe } = state;
    const varIndexName = universe.schema.annotations.var.index;

    // Legal values are null, Array or TypedArray.  Null is initial state.
    if (!set1) set1 = [];
    if (!set2) set2 = [];

    // These lines ensure that we convert any TypedArray to an Array.
    // This is necessary because JSON.stringify() does some very strange
    // things with TypedArrays (they are marshalled to JSON objects, rather
    // than being marshalled as a JSON array).
    set1 = Array.isArray(set1) ? set1 : Array.from(set1);
    set2 = Array.isArray(set2) ? set2 : Array.from(set2);

    const res = await fetch(
      `${globals.API.prefix}${globals.API.version}diffexp/obs`,
      {
        method: "POST",
        headers: new Headers({
          Accept: "application/json",
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          mode: "topN",
          count: num_genes,
          set1: { filter: { obs: { index: set1 } } },
          set2: { filter: { obs: { index: set2 } } }
        }),
        credentials: "include"
      }
    );

    if (!res.ok || res.headers.get("Content-Type") !== "application/json") {
      return dispatchDiffExpErrors(dispatch, res);
    }

    const data = await res.json();
    // result is [ [varIdx, ...], ... ]
    const topNGenes = _.map(data, r =>
      universe.varAnnotations.at(r[0], varIndexName)
    );

    /*
    Kick off secondary action to fetch all of the expression data for the
    topN expressed genes.
    */
    await _doRequestExpressionData(dispatch, getState, topNGenes);

    /* then send the success case action through */
    return dispatch({
      type: "request differential expression success",
      data
    });
  } catch (error) {
    return dispatch({
      type: "request differential expression error",
      error
    });
  }
};

const resetWorldToUniverse = () => (dispatch, getState) => {
  const { universe } = getState();
  reembedResetWorldToUniverse(dispatch, getState);
  dispatch({
    type: "reset World to eq Universe",
    universe
  });
};

const saveObsAnnotations = () => async (dispatch, getState) => {
  const { universe, annotations } = getState();
  const { obsAnnotations, schema } = universe;
  const { dataCollectionNameIsReadOnly, dataCollectionName } = annotations;

  dispatch({
    type: "writable obs annotations - save started"
  });

  const writableAnnotations = schema.annotations.obs.columns
    .filter(s => s.writable)
    .map(s => s.name);
  const df = obsAnnotations.subset(null, writableAnnotations);
  const matrix = MatrixFBS.encodeMatrixFBS(df);
  try {
    const queryString =
      !dataCollectionNameIsReadOnly && !!dataCollectionName
        ? `?annotation-collection-name=${encodeURIComponent(
            dataCollectionName
          )}`
        : "";
    const res = await fetch(
      `${globals.API.prefix}${globals.API.version}annotations/obs${queryString}`,
      {
        method: "PUT",
        body: matrix,
        headers: new Headers({
          "Content-Type": "application/octet-stream"
        }),
        credentials: "include"
      }
    );
    if (res.ok) {
      dispatch({
        type: "writable obs annotations - save complete",
        obsAnnotations
      });
    } else {
      dispatch({
        type: "writable obs annotations - save error",
        message: `HTTP error ${res.status} - ${res.statusText}`,
        res
      });
    }
  } catch (error) {
    dispatch({
      type: "writable obs annotations - save error",
      message: error.toString(),
      error
    });
  }
};

export default {
  doInitialDataLoad,
  requestDifferentialExpression,
  requestSingleGeneExpressionCountsForColoringPOST,
  requestUserDefinedGene,
  requestReembed,
  resetWorldToUniverse,
  saveObsAnnotations,
  setWorldToSelection
};
