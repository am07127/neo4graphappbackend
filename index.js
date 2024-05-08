const express = require('express');
let neo4j = require('neo4j-driver');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());


let driver = neo4j.driver('bolt://localhost:7687', neo4j.auth.basic('neo4j', '12345678'));


app.post('/run-cypher', async (req, res) => {
    const electionType = req.body.type || 'PRESIDENT';
    const params = { type: electionType };
    const query = `
    MATCH (e:Election {type: $type })
    MATCH (c:Candidate)-[r:PARTICIPATED_IN]->(e)
    RETURN e.year AS year, r.party AS party, sum(r.candidatevotes) AS candidate_votes
    `;
    const session = driver.session();
    try {
        const result = await session.run(query, params);
        const data = result.records.map(record => {
            return {
                year: record.get('year').low,  // Assuming 'year' is stored as an integer and not exceeding JavaScript's safe integer limit
                party: record.get('party'),    // Assuming 'party' is a string
                candidate_votes: record.get('candidate_votes').low // Extracting 'low' because JS cannot reliably handle large integers natively
            };
        });
        res.json(data);
    } catch (error) {
        console.error('Error running query', error);
        res.status(500).send({ error: error.message });
    } finally {
        await session.close();
    }
});

app.get('/project-components-graph', async (req, res) => {
  const session = driver.session();
  try {
    // Run the Cypher query just to create the graph projection
    await session.run(`
      CALL gds.graph.project(
        'componentsGraph',
        'Candidate',
        {
          PARTICIPATED_TOGETHER: {
            type: 'PARTICIPATED_TOGETHER',
            orientation: 'UNDIRECTED'
          }
        }
      )
    `);

    // Respond that the graph projection was successful
    res.status(200).send({ message: 'Graph projection created successfully' });
  } catch (error) {
    console.error('Error projecting the graph:', error);
    res.status(500).json({ error: 'An error occurred while projecting the graph' });
  } finally {
    await session.close();
  }
});

app.get('/wcc-components', async (req, res) => {
  const session = driver.session();
  try {
    // Execute the Cypher query to retrieve weakly connected components
    const result = await session.run(`
      CALL gds.wcc.stream('componentsGraph')
      YIELD nodeId, componentId
      RETURN gds.util.asNode(nodeId).name AS Candidate, componentId
      ORDER BY componentId
      LIMIT 10
    `);

    // Extract data into an array of objects
    const wccComponents = result.records.map(record => ({
      Candidate: record.get('Candidate'),
      ComponentId: record.get('componentId').toNumber()
    }));

    // Send the results back as a JSON response
    res.json(wccComponents);
  } catch (error) {
    console.error('Error executing WCC query:', error);
    res.status(500).json({ error: 'An error occurred while executing the WCC query' });
  } finally {
    await session.close();
  }
});

app.get('/candidate-predictions', async (req, res) => {
  const session = driver.session();

  try {
    const result = await session.run(
      'CALL gds.beta.pipeline.linkPrediction.predict.stream("fullGraph", {modelName: "model-candidate", topN: 20}) ' +
      'YIELD node1, node2, probability ' +
      'RETURN gds.util.asNode(node1).name AS candidate1, gds.util.asNode(node2).name AS candidate2, probability ' +
      'ORDER BY probability DESC, candidate1'
    );

    const predictions = result.records.map(record => ({
      candidate1: record.get('candidate1'),
      candidate2: record.get('candidate2'),
      probability: record.get('probability')
    }));

    res.json(predictions);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while executing the query' });
  } finally {
    await session.close();
  }
});



app.get('/candidates', async (req, res) => {
    const session = driver.session();
  
    try {
      // Create the graph projection
      const createProjectionResult = await session.run(
        'CALL gds.graph.project("candidateElectionGraph", ["Candidate", "Election"], ["PARTICIPATED_IN"])'
      );
  
      // Run the degree centrality query
      const degreeCentralityResult = await session.run(
        'CALL gds.degree.stream("candidateElectionGraph") ' +
        'YIELD nodeId, score ' +
        'WHERE gds.util.asNode(nodeId).name IS NOT NULL ' +
        'RETURN gds.util.asNode(nodeId).name AS name, score ' +
        'ORDER BY score DESC'
      );
  
      const candidates = degreeCentralityResult.records.map(record => ({
        name: record.get('name'),
        score: record.get('score')
      }));
  
      res.json(candidates);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'An error occurred while executing the query' });
    } finally {
      await session.close();
    }
  });

  app.get('/betweenness', async (req, res) => {
    const session = driver.session();
  
    try {
      // Create the graph projection
      const createProjectionResult = await session.run(
        'CALL gds.graph.project("betweenGraph","Candidate","PARTICIPATED_TOGETHER")'
      );
  
      // Run the degree centrality query
      const betweenCentralityResult = await session.run(
        'CALL gds.betweenness.stream("betweenGraph")' +
        'YIELD nodeId, score ' +
        'WHERE score>0 ' +
        'RETURN gds.util.asNode(nodeId).name AS name, score ' +
        'ORDER BY score DESC'
      );
  
      const candidates = betweenCentralityResult.records.map(record => ({
        name: record.get('name'),
        score: record.get('score')
      }));
  
      res.json(candidates);
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'An error occurred while executing the query' });
    } finally {
      await session.close();
    }
  });

app.post('/dropprojection', async (req, res) => {
    const session = driver.session();
    const query = 'CALL gds.graph.drop($projection)';
    const params = { projection: req.body.projection };
    try {
        await session.run(query, params);
        res.send('Projection dropped');
    } catch (error) {
        console.error('Error dropping projection', error);
        res.status(500).send({ error: error.message });
    } finally {
        await session.close();
    }
}
);


app.get('/node-count', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (n) RETURN labels(n) AS NodeType, count(n) AS TotalCount'
    );
    const nodeCount = result.records.map(record => ({
      NodeType: record.get('NodeType'),
      TotalCount: record.get('TotalCount').toNumber()
    }));
    res.json(nodeCount);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while executing the query' });
  } finally {
    await session.close();
  }
});


app.get('/total-nodes', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (n) RETURN count(n) AS TotalNodes'
    );
    const totalNodes = result.records[0].get('TotalNodes').toNumber();
    res.json({ totalNodes });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while executing the query' });
  } finally {
    await session.close();
  }
});

app.get('/total-relationships', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH ()-[r]->() RETURN count(r) AS TotalRelationships'
    );
    const totalRelationships = result.records[0].get('TotalRelationships').toNumber();
    res.json({ totalRelationships });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while executing the query' });
  } finally {
    await session.close();
  }
});

app.get('/isolated-nodes', async (req, res) => {
  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (n) WHERE NOT (n)--() RETURN count(n) AS IsolatedNodes'
    );
    const isolatedNodes = result.records[0].get('IsolatedNodes').toNumber();
    res.json({ isolatedNodes });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'An error occurred while executing the query' });
  } finally {
    await session.close();
  }
});

const PORT = 4000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
